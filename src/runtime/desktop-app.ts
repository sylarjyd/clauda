import { isSafeSessionId, listProjects, listSessionSummaries, loadSession } from '../agent/session.js'
import { readAgentSpec } from '../agents/apply.js'
import type { McpServerConfig, PermissionMode } from '../config.js'
import { findVendor } from '../provider/vendors.js'
import { ingestAttachments, sanitizeAttachments } from './attachment.js'
import type { PermissionDecision } from './permission-bridge.js'
import { SessionManager, type EventSink, type Session, type SessionProject } from './session-manager.js'

/**
 * 一条 channel 的返回值。**多带索引签名是有意的**：`desktop/main.js` 只负责把这坨东西
 * 原样丢回 renderer，不该认识任何具体 channel 的字段名 —— 认识一个就会长出第二个。
 */
export interface ChannelResult {
  ok: boolean
  reason?: string
  [key: string]: unknown
}

/** 会话的可序列化快照。renderer 拿到它就能画中栏顶栏和整个右栏 */
export interface SessionInfo {
  id: string
  cwd: string
  model: string
  mode: PermissionMode
  tools: string[]
  todos: unknown
  contextTokens: number
  contextRatio: number
  /** 这条会话绑的智能体名，空串 = 没绑。**不是**项目的默认智能体：同项目两会话可以绑不同的 */
  agentName: string
  /** 新会话空态的**可点问题**，取自这条会话**冻结的**配方（回头按名字查会让老会话跟着改） */
  agentQuestions: string[]
  /** 空串 = 没事。非空时界面弹**一次**通知（快照是高频的，不能每来一次弹一次） */
  agentWarning: string
}

export interface DesktopAppOptions {
  version: string
  sink: EventSink
  /** 按 cwd 建项目运行时。抽成参数是为了让 `desktop-app` 不依赖 MCP、能被单独测 */
  openProject(cwd: string): SessionProject | Promise<SessionProject>
}

/**
 * 桌面端的全部逻辑，**一行 Electron 都没有**。
 *
 * `desktop/main.js` 只做三件事：建窗口、把 `ipcMain.handle` 转成这里的 `handle`、
 * 把 `webContents.send` 适配成 `EventSink`。这样窗口之外的所有行为都还能被
 * `tests/desktop-driver.mjs` 以子进程的方式跑一遍 —— 见 CLAUDA.md 里那条架构约束。
 *
 * 每个 channel 都返回 `{ ok }` 而不是抛异常：IPC 那头的 catch 拿不到堆栈，
 * 抛出去 renderer 只会看到一句「Error invoking remote method」，什么也定位不了。
 */
export class DesktopApp {
  private readonly manager: SessionManager

  constructor(opts: DesktopAppOptions) {
    this.manager = new SessionManager({ sink: opts.sink, openProject: opts.openProject })
  }

  async handle(channel: string, payload?: unknown): Promise<ChannelResult> {
    try {
      switch (channel) {
        case 'project/list':
          return { ok: true, projects: listProjects() }

        case 'session/list':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            sessions: listSessionSummaries(cwd),
          }))

        case 'session/open':
          return await this.openSession(payload)

        case 'session/resume':
          return await this.resumeSession(payload)

        case 'session/state':
          return withSession(this.manager, payload, (session) => ({
            ok: true,
            session: infoOf(session),
          }))

        case 'session/send': {
          // 附件在这里**只核形状**：字节早在 `attachment/ingest` 那一步就读好了，
          // 用户拖进来之后把源文件删掉也不影响发送
          const raw = field(payload, 'attachments')
          const attachments = sanitizeAttachments(raw)
          // 形状不对的会被静默丢掉（见 sanitizeAttachments）。丢几个要说一声 ——
          // 「chip 明明在输入框上、发出去却没有」是那种能查一整晚的问题
          const dropped = Array.isArray(raw) ? Math.max(0, raw.length - attachments.length) : 0
          const res = await this.manager.send(str(payload, 'sessionId'), str(payload, 'text'), attachments)
          return res.ok ? { ok: true, dropped: dropped || undefined } : { ok: false, reason: res.reason }
        }

        case 'attachment/ingest': {
          // 拖拽 / 粘贴 / 选文件都先过这里：读字节、判大小、判路径，返回的不合规项
          // 由 renderer 立刻报进通知栏。发送时不再读盘
          const { attachments, rejected } = await ingestAttachments(field(payload, 'items'))
          return { ok: true, attachments, rejected }
        }

        case 'session/abort':
          this.manager.abort(str(payload, 'sessionId'))
          return { ok: true }

        case 'session/close':
          await this.manager.closeSession(str(payload, 'sessionId'))
          return { ok: true }

        case 'session/set-model':
          return withSession(this.manager, payload, (session) => {
            this.manager.setModel(session.id, str(payload, 'model'))
            return { ok: true }
          })

        case 'session/set-mode':
          return withSession(this.manager, payload, (session) => {
            this.manager.setMode(session.id, str(payload, 'mode') as PermissionMode)
            return { ok: true }
          })

        case 'permission/reply':
          this.manager.replyPermission(
            str(payload, 'sessionId'),
            num(payload, 'requestId'),
            str(payload, 'decision') as PermissionDecision,
          )
          return { ok: true }

        case 'mcp/set-enabled': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          // 不包 try：连不上时 `McpManager.setEnabled` 会抛，正是外层的 catch 把它翻成
          // `{ ok:false, reason }`。在这里吞掉的话，界面会显示「已接入」而工具一个没多
          await this.manager.setMcpEnabled(cwd, str(payload, 'name'), bool(payload, 'enabled'))
          return { ok: true }
        }

        /**
         * 技能与 MCP 的增删。四条通道形状一致：先 `ensureProject`（和 `project/info`
         * 一样带副作用，这个项目可能还没开过会话），再调 `SessionManager` 上对应的方法。
         *
         * **参数不合法一律由 manager 抛**（名字不合规、服务器不存在、命令和 url 都没给…），
         * 外层那个 catch 翻成 `{ok:false, reason}` —— 在这里再判一遍的话，判据就有两份，
         * 迟早出现「通道放行了、manager 又拒了」或者反过来的分歧。
         */
        case 'skill/add': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          const scope = str(payload, 'scope') === 'global' ? 'global' : 'project'
          return {
            ok: true,
            file: this.manager.addSkill(cwd, {
              scope,
              name: str(payload, 'name'),
              description: str(payload, 'description'),
              body: str(payload, 'body'),
            }),
          }
        }

        case 'skill/remove': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          return { ok: true, dir: this.manager.removeSkill(cwd, str(payload, 'name')) }
        }

        /**
         * 技能页那个开关。
         *
         * 参数叫 `disabled` 而不是 `enabled`：界面那侧是个「关掉这个技能」的开关，直接传
         * 目标状态，「开」= 没勾。传 `enabled` 的话这里要写一次取反，而取反写错是那种
         * 「开关方向和显示相反」的 bug —— 真出现时没人会想到去看 IPC 这一行。
         *
         * `scope` **和 `skill/add` 的默认值相反**（那边默认 project）：这里默认 global。
         * 技能本来就是全局装的多（`~/.clauda/skills` 那一批），而它省下来的 token 是
         * **每个项目**都省的 —— 默认写项目等于让人一个一个项目关过去。
         */
        case 'skill/set-disabled': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          const scope = str(payload, 'scope') === 'project' ? 'project' : 'global'
          return {
            ok: true,
            files: this.manager.setSkillDisabled(cwd, str(payload, 'name'), bool(payload, 'disabled'), scope),
          }
        }

        case 'mcp/add': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          const cfg = field(payload, 'config')
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
            return { ok: false, reason: 'mcp/add 需要 config 对象' }
          }
          await this.manager.ensureProject(cwd)
          const scope = str(payload, 'scope') === 'global' ? 'global' : 'project'
          // 不包 try：连不上时 `addServer` 会抛，正是外层 catch 翻成人话给用户看
          return {
            ok: true,
            file: await this.manager.addMcpServer(cwd, scope, str(payload, 'name'), cfg as McpServerConfig),
          }
        }

        case 'mcp/remove': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          return { ok: true, file: await this.manager.removeMcpServer(cwd, str(payload, 'name')) }
        }

        /**
         * 一台服务器的工具明细。**没有塞进 `project/info`**：那一份每轮徽标刷新都要重算，
         * 而 88 条工具的说明加起来比整份 `ProjectInfo` 还大。谁展开那一行谁付这笔钱。
         */
        case 'mcp/tools/get': {
          const cwd = str(payload, 'cwd')
          const name = str(payload, 'name')
          if (!cwd || !name) return { ok: false, reason: '缺少参数 cwd / name' }
          await this.manager.ensureProject(cwd)
          return { ok: true, tools: this.manager.mcpToolCatalog(cwd, name) }
        }

        /**
         * 改一台服务器的工具白名单。
         *
         * `tools` 收的是**三态**，别拿 `strList()` 那一套来收：`null` 是「不要白名单了」
         * （全接），数组是「就要这几个」—— 空数组是其中的一档，意思是「一个都不接」。
         * 把 `null` 和 `[]` 合并成 `undefined` 的话，「一个都不接」这个诉求就永远表达不出来，
         * 而它恰好是唯一能把一台服务器接上却不让它占一行 schema 的写法。
         *
         * 类型不对**拒掉**而不是猜：往任何一侧猜都是替用户改了他没说的东西。
         */
        case 'mcp/tools/set': {
          const cwd = str(payload, 'cwd')
          const name = str(payload, 'name')
          if (!cwd || !name) return { ok: false, reason: '缺少参数 cwd / name' }
          const raw = field(payload, 'tools')
          if (raw !== null && !Array.isArray(raw)) {
            return { ok: false, reason: 'tools 得是字符串数组或 null' }
          }
          await this.manager.ensureProject(cwd)
          const tools =
            raw === null
              ? undefined
              : raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
          const file = this.manager.setMcpTools(cwd, name, tools)
          // 名字在运行期有、两份配置里都没有，只可能是「运行期临时加的服务器」。报错而不是
          // 假装成功：界面要是显示改好了，用户重启一次就会发现白改
          if (!file) return { ok: false, reason: `没找到「${name}」写在哪个配置文件里，白名单没改` }
          return { ok: true, file, tools: this.manager.mcpToolCatalog(cwd, name) }
        }

        /**
         * 智能体的增删改查。形状同上面四条：先 `ensureProject`，再委托 manager，
         * 参数不合法由 manager 抛、外层 catch 翻成 `{ok:false, reason}`。
         *
         * **`tools` / `skills` / `questions` 走数组，不走分隔符字符串**：`,` 与 `|` 是
         * **文件格式**的事，归 `writeAgent` 管（连 `|` 的转义都在那儿）。IPC 传数组，
         * 渲染层只在自己那边按行拆一次，两边各写一套 split 迟早分叉。
         *
         * `agent/add` **不触发工具广播**（改智能体只影响新会话），所以这里也不需要
         * 那些技能 / MCP 通道里的刷新动作 —— 理由写在 `SessionManager.addAgent` 上。
         */
        case 'agent/add': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          const scope = str(payload, 'scope') === 'global' ? 'global' : 'project'
          const permission = str(payload, 'permission')
          const result = this.manager.addAgent(cwd, {
            scope,
            name: str(payload, 'name'),
            description: str(payload, 'description'),
            body: str(payload, 'body'),
            // 空串一律落成 `undefined`（= 文件里不写这个键 = 沿用项目当前那份）。
            // 把 `''` 原样写进文件会读成「显式设成空」，逐键覆盖的语义就反了
            profile: strOrUndef(payload, 'profile'),
            model: strOrUndef(payload, 'model'),
            temperature: numOrUndef(payload, 'temperature'),
            // 认不出的值当没给：写进去也只是被注册表忽略，不如在边界上就统一口径
            permission: isPermissionMode(permission) ? permission : undefined,
            allow: strList(payload, 'allow'),
            deny: strList(payload, 'deny'),
            tools: strList(payload, 'tools'),
            skills: strList(payload, 'skills'),
            questions: strList(payload, 'questions'),
          })
          // 「同名整份覆盖」，所以 `created` 决定界面说「已新建」还是「已保存」
          return { ok: true, file: result.file, created: result.created }
        }

        case 'agent/get': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          // 名字不存在时 `getAgent` 抛，外层翻成人话 —— **不能静默成功**，
          // 那会让用户对着一个空表单以为「它本来就是空的」
          return { ok: true, agent: this.manager.getAgent(cwd, str(payload, 'name')) }
        }

        case 'agent/remove': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          return { ok: true, dir: this.manager.removeAgent(cwd, str(payload, 'name')) }
        }

        /**
         * 标「本项目默认」。'' = 取消默认。只影响之后新开的会话 ——
         * 已经在跑的会话绑定是冻结的（同「模型 / 端点只对新会话生效」）。
         */
        case 'project/set-default-agent':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setDefaultAgent(cwd, str(payload, 'name')),
          }))

        /**
         * 设置页（模型 / 技能 / MCP）唯一的数据源，**按 cwd 取**。
         *
         * 这条通道**有副作用**：第一次调用会把项目运行时建起来。技能与 MCP 挂在它
         * 上面（MCP 子进程的宿主就是它），而配技能和 MCP 正是开第一个会话之前想做的事 ——
         * 以前这里按 sessionId 取，于是那一刻三个页面只剩「还没有打开的会话」。
         * 副作用是幂等的，多一次往返不值当，所以合在「取快照」这一条里。
         */
        case 'project/info': {
          const cwd = str(payload, 'cwd')
          if (!cwd) return { ok: false, reason: '缺少参数 cwd' }
          await this.manager.ensureProject(cwd)
          const info = this.manager.projectInfo(cwd)
          return info ? { ok: true, info } : { ok: false, reason: '项目运行时还没就绪' }
        }

        /**
         * 改**某一份档案**的接口地址 / 默认模型。`profileKey` 是设置页左栏选中的那份，
         * 不带就落到当前使用的那份上。
         */
        case 'project/set-default-model': {
          const model = str(payload, 'model').trim()
          if (!model) return { ok: false, reason: '模型名不能为空' }
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setProfileField(cwd, { model }, str(payload, 'profileKey')),
          }))
        }

        case 'project/set-base-url': {
          const baseUrl = str(payload, 'baseUrl').trim()
          if (!baseUrl) return { ok: false, reason: '接口地址不能为空' }
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setProfileField(cwd, { baseUrl }, str(payload, 'profileKey')),
          }))
        }

        /**
         * 添加一份厂商档案。地址与模型从预置表取，于是和从前一样不存在「写一个界面没
         * 提供过的地址」这条路径；自定义那份地址留空，由用户手填（走 `set-base-url`）。
         *
         * **认不出的 key 一律按自定义处理** —— `__custom__` 走的就是这条（`findVendor`
         * 里没有它）。真要做成「未知厂商报错」，那个哨兵值就得在这一层再认一次。
         */
        case 'project/add-profile': {
          const key = str(payload, 'vendorKey')
          if (!key) return { ok: false, reason: '缺少参数 vendorKey' }
          return withStr(payload, 'cwd', (cwd) => {
            const added = this.manager.addProfile(cwd, findVendor(key) ?? null)
            return { ok: true, file: added.file, key: added.key }
          })
        }

        /**
         * 切换当前使用的档案。**这条才是「换厂商」**，`project/add-profile` 只加不改。
         *
         * 参数不合法由 `setActiveProfile` 抛，外层 catch 翻成 `{ok:false, reason}` ——
         * 「档案不存在」「还缺接口地址」那几句人话就是用户看到的提示。
         */
        case 'project/set-active-provider':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.setActiveProfile(cwd, str(payload, 'profileKey')),
          }))

        /** 删掉一份档案。当前使用的那份删不了（理由见 `SessionManager.removeProfile`） */
        case 'project/remove-profile':
          return withStr(payload, 'cwd', (cwd) => ({
            ok: true,
            file: this.manager.removeProfile(cwd, str(payload, 'profileKey')),
          }))

        case 'app/quit':
          await this.manager.disposeAll()
          return { ok: true }

        default:
          return { ok: false, reason: `未知通道：${channel}` }
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  private async openSession(payload: unknown): Promise<ChannelResult> {
    const cwd = str(payload, 'cwd')
    if (!cwd) return { ok: false, reason: 'session/open 需要 cwd' }
    const id = str(payload, 'id')
    // 这层拦一道是为了给出人话错误。真正的兜底在 session.ts —— 那边的 id 还可能
    // 来自会话文件内容，只堵 IPC 是堵不住的
    if (id && !isSafeSessionId(id)) return { ok: false, reason: `非法会话 id：${id}` }
    // `agent` 是名字（'' = 明确不要智能体）。**主进程没有「没给名字就用 `defaultAgent`」这条魔法**
    // —— 那个回退太容易咬人（见 `openSession` 里 `pickAgent` 那段）。所以「套项目默认」这件事
    // 只发生在界面那一格下拉框的初始值里：渲染层总是发一个具体值进来
    const session = await this.manager.openSession(cwd, {
      ...(id ? { id } : {}),
      agent: str(payload, 'agent'),
    })
    return { ok: true, session: infoOf(session) }
  }

  /**
   * 从历史里打开一个会话。**沿用原来的 id**：换一个 id 的话续聊会写成新文件，
   * 被恢复的那个会话永不更新（CLAUDA.md 里点名的坑，CLI 的 `--resume` 同）。
   *
   * 连消息一起返回：renderer 要把当初的对话重画出来。`session/state` 不带 messages
   * 是有意的 —— 那个通道每轮都调一次，捎上整份历史纯属浪费。
   */
  private async resumeSession(payload: unknown): Promise<ChannelResult> {
    const cwd = str(payload, 'cwd')
    const id = str(payload, 'id')
    if (!cwd || !id) return { ok: false, reason: 'session/resume 需要 cwd 和 id' }
    // id 会一路流到 `saveSession` 的写路径（`persist.ts` 用同一个 id 续写文件），
    // 所以这里挡的不是「读错文件」，是「写到别处去」
    if (!isSafeSessionId(id)) return { ok: false, reason: `非法会话 id：${id}` }

    const rec = loadSession(cwd, id)
    if (!rec) return { ok: false, reason: `找不到会话：${id}` }

    // 同一个 id 已经开着就先关掉。直接覆盖 Map 里的条目会让项目的引用计数永远归不了零，
    // 那个项目的 MCP 子进程就再也 dispose 不掉了
    if (this.manager.getSession(id)) await this.manager.closeSession(id)

    const session = await this.manager.openSession(cwd, {
      id,
      snapshot: {
        messages: rec.messages,
        todos: rec.todos ?? [],
        totalUsage: rec.totalUsage ?? { input: 0, output: 0 },
        cost: rec.cost ?? 0,
      },
      // **永远传 `agentSpec`，哪怕值是 `null`。** 传 `null` 和省略不是一个意思：省略会落进
      // 「新会话」分支去套**当下的**项目默认，于是一条从没绑过智能体的旧会话会在用户什么都
      // 没点的情况下悄悄变成默认智能体 —— 行为静默改变，最难查的一类。
      // `readAgentSpec` 过一遍形状：会话文件是磁盘上的明文 JSON，手改得坏，而
      // `isSessionRecord` 刻意不验这个键（见 `agent/session.ts`）
      agentSpec: readAgentSpec(rec.agent) ?? null,
    })
    return { ok: true, session: infoOf(session), messages: rec.messages }
  }
}

function infoOf(session: Session): SessionInfo {
  return {
    id: session.id,
    cwd: session.cwd,
    model: session.config.provider.model,
    mode: session.permissions.mode,
    tools: session.agent.listTools().map((t) => t.name),
    todos: session.agent.todos.toJSON(),
    contextTokens: session.agent.contextTokens(),
    contextRatio: session.agent.contextUsageRatio(),
    agentName: session.agentName,
    agentQuestions: session.agentSpec?.questions ?? [],
    // 名字给过却解析不出来（比如它刚被删掉）时才提示。自动恢复的会话不该因为一个消失的智能体
    // 就打不开，所以这里只是「说一声」，不是错误
    agentWarning: session.agentMissing
      ? `智能体「${session.agentMissing}」已经不在了，这个会话按默认配置打开`
      : '',
  }
}

/** 会话类 channel 的共同前戏：拿不到会话就没必要往下走，统一在这里返回失败 */
function withSession(
  manager: SessionManager,
  payload: unknown,
  fn: (session: Session) => ChannelResult,
): ChannelResult {
  const session = manager.getSession(str(payload, 'sessionId'))
  if (!session) return { ok: false, reason: '会话不存在' }
  return fn(session)
}

function withStr(payload: unknown, key: string, fn: (value: string) => ChannelResult): ChannelResult {
  const value = str(payload, key)
  if (!value) return { ok: false, reason: `缺少参数 ${key}` }
  return fn(value)
}

/** 取原始字段。附件那两条 channel 收的就是未知形状（renderer 从 DataTransfer 里抄来的） */
function field(payload: unknown, key: string): unknown {
  return (payload as Record<string, unknown> | null)?.[key]
}

function str(payload: unknown, key: string): string {
  const value = field(payload, key)
  return typeof value === 'string' ? value : ''
}

function num(payload: unknown, key: string): number {
  const value = field(payload, key)
  return typeof value === 'number' ? value : 0
}

function bool(payload: unknown, key: string): boolean {
  return field(payload, key) === true
}

const PERMISSION_MODES: readonly string[] = ['default', 'auto', 'plan']

function isPermissionMode(v: string): v is PermissionMode {
  return PERMISSION_MODES.includes(v)
}

/** 空串 = 「没填这一栏」= 文件里不写这个键。IPC 那头拿到的 `''` 正是这个意思 */
function strOrUndef(payload: unknown, key: string): string | undefined {
  const value = str(payload, key).trim()
  return value || undefined
}

/**
 * 数字参数。**缺键 / 非数字一律 `undefined`**，不能借 `num()` 那个 0 兜底 ——
 * 温度 0 是有效配置（也是常用值），用 0 代表「没填」会把它悄悄换成 0 然后看起来对。
 */
function numOrUndef(payload: unknown, key: string): number | undefined {
  const value = field(payload, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 数组参数。非数组（缺键 / 类型不对）和空数组都返回 `undefined` —— 在写盘那边两者等价
 * （都不写那一行），这里合并没有信息损失，还能挡住 renderer 传错类型时静默写成一行空配置。
 */
function strList(payload: unknown, key: string): string[] | undefined {
  const raw = field(payload, key)
  if (!Array.isArray(raw)) return undefined
  const list = raw
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return list.length > 0 ? list : undefined
}

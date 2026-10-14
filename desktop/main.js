/**
 * Electron 主进程 —— **刻意只有五件事**：建窗口、摘掉默认菜单、把 `app://` 映射到
 * renderer 目录、转发 IPC、在退出时把 MCP 子进程收干净。
 *
 * 一行业务逻辑都不许进来。`DesktopApp`（`dist/runtime/desktop-app.js`）才是逻辑所在，
 * 它不依赖 Electron，所以能被 `tests/desktop-driver.mjs` 用子进程跑一遍。
 * 这里每多写一行判断，就多一行只有人工点窗口才能验到的代码。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const RENDERER_DIR = path.join(HERE, 'renderer')

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const { DesktopApp } = await import(pathToFileURL(path.join(ROOT, 'dist', 'runtime', 'desktop-app.js')).href)
const { createProjectRuntime } = await import(
  pathToFileURL(path.join(ROOT, 'dist', 'runtime', 'project.js')).href
)

/**
 * renderer 用 ESM（`state.js` 要能被单测 import），而 `file://` 下的
 * `<script type="module">` 会被 Chromium 的 CORS 拦掉。把 renderer 目录挂到一个
 * 自定义标准协议上就有正常的源了 —— 比把 renderer 降级成经典脚本干净。
 *
 * `registerSchemesAsPrivileged` 必须在 ready 之前调用，所以只能放模块顶层。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

/** 当前所有窗口的广播。窗口可能已经关了，直接 send 会抛 */
const sink = {
  send(sessionId, event) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('clauda:event', sessionId, event)
      }
    }
  },
}

const desktop = new DesktopApp({
  version: VERSION,
  sink,
  openProject: (cwd) =>
    createProjectRuntime({
      cwd,
      version: VERSION,
      // MCP 连不上之类的诊断**只留在控制台**，不往界面推。
      //
      // 通知栏是「你刚做了什么、成没成」的地方（它待在侧栏之外，正是为了让设置页上的
      // 报错看得见，见 CLAUDA.md），而这条消息带的是子进程的原始报错，一屏好几行技术
      // 细节 —— 用户嘴里的「日志」就是它。
      //
      // 这不算把失败藏起来：连不上的那台在「工具」页上会红着（`state: 'failed'`）并带着
      // 它自己的错误原文，徽标上的已连接数也跟着掉。要看现场还有这一行 console。
      onWarn: (msg) => console.warn('[clauda]', msg),
    }),
})

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    // 和 style.css 的 --bg 保持一致：差一档的话窗口起来那一下会闪一下别的颜色
    backgroundColor: '#f7f5f1',
    title: 'clauda',
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // renderer 崩了，主进程里那些「等用户点授权」的 Promise 就再也没人来结清了，
  // runTurn 会一直挂在那一句 await 上，连带进程也退不掉。直接全清掉。
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[clauda] renderer 挂了：', details.reason)
    void desktop.handle('app/quit')
  })

  /**
   * **必须有的两个守卫**，都是「往窗口上拖文件」这个动作引出来的：
   *
   * Chromium 对落在没监听的区域上的拖放，默认行为是**导航到那个 file://** —— 整个 UI
   * 被那个文件顶掉，而且没有返回键，只能关窗重开。renderer 那边只在 `.app` 上监听了
   * 拖放，窗口的边缘、导航栏的空隙都不在它管辖范围内，所以这里必须兜住。
   *
   * `app://clauda/` 是启动那一次（以及将来可能的页面内跳转）要走的路，其余一律拦下。
   * `setWindowOpenHandler` 顺手也关掉：这个应用没有任何需要开新窗的场景。
   */
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://clauda/')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void win.loadURL('app://clauda/index.html')
  return win
}

app.whenReady().then(() => {
  /**
   * 默认菜单（File / Edit / View / Window / Help）里没有一项是这个应用用得上的，
   * 却白占一条窗口顶部。**只在非 macOS 上摘**：macOS 的 Cmd+Q、Cmd+H、Cmd+W 以及
   * 复制粘贴都走菜单项的角色，摘掉等于把「退出」和「粘贴」一起摘了。
   *
   * Windows / Linux 上不担心复制粘贴：那两条由 Blink 在可编辑元素里自己处理，
   * 不经过菜单的加速键（菜单项的角色只是给 macOS 和「点菜单」这两条路用的）。
   */
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  protocol.handle('app', async (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    const file = path.resolve(RENDERER_DIR, rel || 'index.html')
    // 目录穿越：`../` 会被 URL 规范化掉，但 `..%2f` 这类编码形式不会，所以还要再查一遍
    if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })

  ipcMain.handle('clauda:invoke', (_e, channel, payload) => desktop.handle(channel, payload))
  ipcMain.handle('clauda:pick-directory', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  // 和 pick-directory 一样不走 desktop.handle：它要的是 Electron 的 dialog，
  // 而不是任何业务逻辑。读字节、判大小那些都在 attachment/ingest 里
  ipcMain.handle('clauda:pick-files', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return res.canceled ? null : res.filePaths
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// 退出前必须把 MCP 子进程关掉，否则事件循环一直活着 —— 表现是关窗之后进程不消失。
// `before-quit` 里不能直接 await，先 preventDefault 挡住这一次，清完再 quit 一次
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void desktop
    .handle('app/quit')
    .catch((err) => console.error('[clauda] 退出清理出错：', err))
    .finally(() => app.quit())
})

/**
 * renderer ↔ 主进程之间唯一的通道。
 *
 * **必须是 CJS**：`sandbox: true` 的 preload 跑在受限环境里，只认 CommonJS，
 * 用 ESM 写会在窗口起来之前就报错（而那时控制台什么都看不到，只有空白窗口）。
 * 后缀是 `.cjs` 而不是 `.js`，因为根 package.json 是 `"type": "module"`。
 *
 * 只往外暴露几个函数，**不暴露 `ipcRenderer` 本身** —— 暴露出去等于把「能往主进程
 * 发任意 channel」的能力交给了页面，`sandbox` 和 `contextIsolation` 就白开了。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('clauda', {
  invoke: (channel, payload) => ipcRenderer.invoke('clauda:invoke', channel, payload),

  /** 订阅会话事件。返回取消订阅的函数，窗口重载前要调，否则监听器会越堆越多 */
  onEvent: (handler) => {
    const listener = (_event, sessionId, payload) => handler(sessionId, payload)
    ipcRenderer.on('clauda:event', listener)
    return () => ipcRenderer.off('clauda:event', listener)
  },

  pickDirectory: () => ipcRenderer.invoke('clauda:pick-directory'),

  pickFiles: () => ipcRenderer.invoke('clauda:pick-files'),

  /**
   * 拖进来 / 粘上来的 File 对应的磁盘路径。
   *
   * **Electron 32 起 `File.path` 被删了**，这是唯一还算数的取法。三件事必须记住：
   * 它**同步**（别 await）、对**没有磁盘来源**的 File 返回**空串**（截图、网页里复制的图
   * 都是这一类，renderer 得用 `FileReader` 兜底）、对**不是 File 的对象会抛**
   * （所以这里包 try）。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})

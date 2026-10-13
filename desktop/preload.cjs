/**
 * renderer ↔ 主进程之间唯一的通道。
 *
 * **必须是 CJS**：`sandbox: true` 的 preload 跑在受限环境里，只认 CommonJS，
 * 用 ESM 写会在窗口起来之前就报错（而那时控制台什么都看不到，只有空白窗口）。
 * 后缀是 `.cjs` 而不是 `.js`，因为根 package.json 是 `"type": "module"`。
 *
 * 只往外暴露三个函数，**不暴露 `ipcRenderer` 本身** —— 暴露出去等于把「能往主进程
 * 发任意 channel」的能力交给了页面，`sandbox` 和 `contextIsolation` 就白开了。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clauda', {
  invoke: (channel, payload) => ipcRenderer.invoke('clauda:invoke', channel, payload),

  /** 订阅会话事件。返回取消订阅的函数，窗口重载前要调，否则监听器会越堆越多 */
  onEvent: (handler) => {
    const listener = (_event, sessionId, payload) => handler(sessionId, payload)
    ipcRenderer.on('clauda:event', listener)
    return () => ipcRenderer.off('clauda:event', listener)
  },

  pickDirectory: () => ipcRenderer.invoke('clauda:pick-directory'),
})

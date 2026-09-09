// 打包成 Node SEA 单文件可执行程序后，所有代码被 esbuild 合并成一个文件，
// __dirname 会变成"可执行文件自身所在目录"（相当于项目根目录），不再是 src/，
// 不需要再 '..' 跳一级；普通 `node src/server.js` 运行时 __dirname 是 src/，要跳一级。
// 已用真实打包流程验证过：SEA 模式下不跳级时 web/、data/ 都能正确落在可执行文件旁边，
// 不管从哪个工作目录启动都不受影响。
const path = require('path');
let isSea = false;
try { isSea = require('node:sea').isSea(); } catch { /* 不支持 node:sea 的老版本，按非SEA处理 */ }
const baseDir = isSea ? __dirname : path.join(__dirname, '..');
module.exports = { baseDir, isSea };

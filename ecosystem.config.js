// PM2 配置（跨平台进程守护 + 开机自启，Linux/Windows/macOS 通用）
// 用法：
//   npm i -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup   (按提示配置开机自启)
module.exports = {
  apps: [
    {
      name: 'txbot',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      watch: false,
      env: {
        PORT: 8787,
        HOST: '0.0.0.0',
        // 想开启登录保护(强烈建议)就取消注释并填自己的账号密码：
        // TXBOT_USER: 'admin',
        // TXBOT_PASS: '换成你自己的密码',
      },
    },
  ],
};

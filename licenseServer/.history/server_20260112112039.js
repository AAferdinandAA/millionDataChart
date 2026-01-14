const http = require('http');

const PORT = 24278;

const server = http.createServer((req, res) => {
  // 核心：添加 CORS 响应头
  res.setHeader('Access-Control-Allow-Origin', '*');           // 允许所有来源（最宽松）
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 重要！处理浏览器的预检请求（OPTIONS）
  if (req.method === 'OPTIONS') {
    res.writeHead(204); // 204 No Content
    res.end();
    return;
  }

  if (req.url === '/license' || req.url === '/license/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('true');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`License server running on port ${PORT}`);
});
import os from 'node:os';

process.env.HOST = '0.0.0.0';
const port = Number(process.env.PORT) || 3000;
const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((item) => item && (item.family === 'IPv4' || item.family === 4) && !item.internal)
  .map((item) => item.address);

console.log('Режим локальной сети. Доступ с телефона или другого компьютера:');
if (addresses.length) {
  for (const address of addresses) console.log(`  http://${address}:${port}`);
} else {
  console.log('  сетевые адреса не найдены — проверьте подключение к Wi-Fi');
}
console.log('Разрешите Node.js доступ в брандмауэре для частных сетей.');
console.log('');

await import('../server.js');

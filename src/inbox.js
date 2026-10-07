// Posts one message into a session's inbox: connect, write one line, close.
// Tested on the Mac 7 Oct 2026; the docs say the same works on Linux with no
// sign-in line.
import net from 'node:net';

export function postToInbox(socketPath, text, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('inbox did not answer in time'));
    }, timeoutMs);
    sock.on('connect', () => {
      sock.end(line, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Exercise real listeners while translating only netstat's display text.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const original = childProcess.execFile;
childProcess.execFile = function (file, args, options, callback) {
  if (file !== 'netstat.exe') return original.apply(this, arguments);
  return original.call(this, file, args, options, (error, stdout, stderr) => {
    callback(error, stdout.replaceAll('LISTENING', 'ABHÖREN'), stderr);
  });
};
// execFile's promise API resolves both output streams, unlike a generic callback
// promisifier. Preserve that contract for every native command used by the host.
Object.defineProperty(childProcess.execFile, promisify.custom, {
  value: (...args) => new Promise((resolve, reject) => {
    childProcess.execFile(...args, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  }),
});
syncBuiltinESMExports();

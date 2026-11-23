import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const write = fs.writeFileSync;
fs.writeFileSync = (file, data, options) => {
  if (String(file).includes('task-artifact-versions')) {
    write(file, Buffer.from(data).subarray(0, 4), options);
    process.exit(74);
  }
  return write(file, data, options);
};
syncBuiltinESMExports();
const { TaskFiles } = await import('../../src/process-runtime/task-files.ts');
const files = new TaskFiles(process.argv[2], process.argv[3], { assignmentId: () => 'assignment', assignmentExists: () => true });
files.register('ticket', [{ path: 'result.bin' }]);
throw new Error('The crash checkpoint was not reached');

import { sanitizePreambleForModel } from '../src/utils/preambleSanitizer.mjs';

const pre = 'Intro\n```text\n<execute_command>\n<command>echo "Hello, World!"</command>\n</execute_command>\nMore';
console.log('orig:', pre);
console.log(sanitizePreambleForModel(pre, false));
console.log(sanitizePreambleForModel(pre, true));

const pre2 = 'Context: <list_files/> \n more text';
console.log(sanitizePreambleForModel(pre2, false));

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = await mkdtemp('/tmp/allagents-588-tui-');
for (const dir of ['home/.allagents','home/.config/Code/User','project/.allagents','vscode-plugin','copilot-plugin']) await mkdir(join(root,dir),{recursive:true});
for (const client of ['vscode','copilot']) {
const dir=join(root,client+'-plugin');
await writeFile(join(dir,'plugin.json'),JSON.stringify({name:client+'-plugin',version:'1.0.0'}));
await writeFile(join(dir,'.mcp.json'),JSON.stringify({mcpServers:{alpha:{command:'echo',args:['alpha']},beta:{command:'echo',args:['beta']}}}));
}
await writeFile(join(root,'home/.allagents/workspace.yaml'),`repositories: []\nclients: [vscode, copilot]\nplugins:\n  - source: ${root}/vscode-plugin\n    clients: [vscode]\n  - source: ${root}/copilot-plugin\n    clients: [copilot]\n`);
await writeFile(join(root,'project/.allagents/workspace.yaml'),'repositories: []\nclients: [vscode, copilot]\nplugins: []\n');
await writeFile(join(root,'home/.config/Code/User/mcp.json'),'{\n // User-owned legacy file\n "servers": {"personal":{"command":"echo","args":["personal"]}}\n}\n');
await writeFile('/tmp/allagents-588-evidence/tui-root.txt',root);
await writeFile('/tmp/allagents-588-evidence/launch-tui.sh',`#!/bin/sh\ncd '${root}/project'\nexport HOME='${root}/home'\nexport ALLAGENTS_TEST_HOME='${root}/home'\nunset COPILOT_HOME\nexec bun '${process.cwd()}/dist/index.js'\n`);
console.log(root);

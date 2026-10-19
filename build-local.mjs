import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {makeExchangePrompt,exchangeExample} from './dist/exchange.js';
const root=new URL('./',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const clean=source=>source.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'');
const moduleBlock=(source,names)=>`const {${names.join(',')}} = (() => {\n${clean(source)}\nreturn {${names.join(',')}};\n})();`;
const data=moduleBlock(await read('dist/examples.js'),['examples']);
const engine=moduleBlock(await read('dist/engine.js'),['splitSentences','validateImport','findTextIndex','documentBlocks','MAX_DOCUMENT_CHARS']);
const exchange=moduleBlock(await read('dist/exchange.js'),['readImport','mergeImport','makeExchangePrompt']);
const annotations=moduleBlock(await read('dist/annotations.js'),['renderAnnotatedSentence','clauseAnnotations','createAnnotationLayout']);
const app=clean(await read('dist/app.js'));
const script=`(() => {\n${data}\n${engine}\n${annotations}\n${exchange}\n${app}\n})();`.replace(/<\/script/gi,'<\\/script');
let html=await read('dist/index.html');
html=html.replace('<link rel="stylesheet" href="style.css">',`<style>${await read('dist/style.css')}</style>`)
 .replace('<script type="module" src="app.js"></script>','')
 .replace('class="brand" href="./"','class="brand" href="#"')
 .replace('</body>',`<script>\n${script}\n</script>\n</body>`);
const output=new URL('./句读.html',root);
await writeFile(output,html);
await writeFile(new URL('./给GPT的标注指令.txt',root),makeExchangePrompt());
await writeFile(new URL('./标注格式示例.json',root),JSON.stringify(exchangeExample,null,2));
console.log(fileURLToPath(output));

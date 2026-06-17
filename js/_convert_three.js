const fs = require('fs');
const input = fs.readFileSync('D:/AI/MOD/custom_nodes/ComfyUI_GJJ_Nodes/js/three.min.js', 'utf8');
const output = '(function(g){\n' + input + '\n;g.THREE=THREE;\n})(typeof window!=="undefined"?window:this);';
fs.writeFileSync('D:/AI/MOD/custom_nodes/ComfyUI_GJJ_Nodes/js/three.umd.js', output);
console.log('Converted to UMD, size:', (output.length/1024/1024).toFixed(2), 'MB');

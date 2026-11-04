'use strict';
const fs=require('node:fs'), path=require('node:path'), {pathToFileURL}=require('node:url');
const {app,BrowserWindow}=require('electron');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'.tools/presence-gif/frames');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',path.join(root,'.tools/presence-gif/profile'));
app.disableHardwareAcceleration();app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const sprite=pathToFileURL(path.join(root,'app/src/renderer/js/sprite.js')).href;
const image=pathToFileURL(path.join(root,'app/assets/capri/capri-full.png')).href;
const html='<!doctype html><meta charset="utf-8"><canvas id="sprite" hidden></canvas><canvas id="out" width="512" height="512"></canvas><script type="module">'+
  'import {SpriteRenderer,SPRITE} from '+JSON.stringify(sprite)+';'+
  'const image=new Image();image.src='+JSON.stringify(image)+';await image.decode();const renderer=new SpriteRenderer(document.getElementById("sprite"),image);renderer.resize(.82);'+
  'const output=document.getElementById("out"),ctx=output.getContext("2d");'+
  'window.renderFrame=(i)=>{const phase=i/48*Math.PI*2,step=i/8*Math.PI*2,dir=Math.cos(phase)>=0?1:-1;'+
  'renderer.draw({seed:i%8,boil:.8,hair:-3+Math.sin(step)*3,head:.07*dir,mane:.2,armL:.15+Math.sin(step)*.5,armR:.15-Math.sin(step)*.5,longL:1,longR:1,sit:0,kickL:.65*Math.sin(step),kickR:-.65*Math.sin(step),smear:[0,0],echo:[0,0],glitch:0,glitchSeed:0,split:0,collapse:0,dissolve:0,sparkle:1,grade:1,sil:[.08,.06,.11],silAmount:0,misreg:[-2.6,2.2],alpha:1});'+
  'ctx.fillStyle="#140e20";ctx.fillRect(0,0,512,512);const g=ctx.createRadialGradient(256,270,20,256,270,245);g.addColorStop(0,"#2c1646");g.addColorStop(1,"#140e20");ctx.fillStyle=g;ctx.fillRect(0,0,512,512);'+
  'ctx.strokeStyle="#7b2eff";ctx.lineWidth=2;ctx.strokeRect(14,14,484,484);ctx.fillStyle="#35ff7a";ctx.fillRect(14,14,48,3);ctx.fillRect(450,495,48,3);'+
  'ctx.fillStyle="#35ff7a";ctx.font="bold 19px monospace";ctx.textAlign="center";ctx.fillText("CAPRI",256,47);'+
  'ctx.strokeStyle="#4e2c70";ctx.beginPath();ctx.ellipse(256,445,170,9,0,0,Math.PI*2);ctx.stroke();'+
  'ctx.save();ctx.translate(256+Math.sin(phase)*87,435-Math.abs(Math.sin(step))*10);ctx.rotate(dir*.09);ctx.scale(dir,1);ctx.drawImage(renderer.canvas,-(SPRITE.pad+SPRITE.feet.x)*.82,-(SPRITE.pad+SPRITE.feet.y)*.82);ctx.restore();'+
  'return output.toDataURL("image/png");};window.ready=true;</script>';
const page=path.join(output,'render.html');fs.writeFileSync(page,html);
app.whenReady().then(async()=>{let win;try{
  win=new BrowserWindow({width:530,height:560,show:false,webPreferences:{webSecurity:false,backgroundThrottling:false,contextIsolation:true,sandbox:true}});
  await win.loadFile(page);
  await win.webContents.executeJavaScript('new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(window.ready){clearInterval(t);resolve(true);}else if(++n>100){clearInterval(t);reject(new Error("renderer not ready"));}},50);})');
  for(let i=0;i<48;i++){const data=await win.webContents.executeJavaScript('window.renderFrame('+i+')');fs.writeFileSync(path.join(output,String(i).padStart(3,'0')+'.png'),Buffer.from(data.split(',')[1],'base64'));}
  console.log(JSON.stringify({ok:true,frames:48,width:512,height:512,fps:12,output}));
}catch(error){console.error(error.stack);process.exitCode=1;}finally{win?.destroy();app.quit();}});

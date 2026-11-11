#!/usr/bin/env python3
"""Render actual agent-tui screenshots into captioned H.264 evidence.
Usage: python3 renderer.py manifest.json output.mp4
Manifest: [{"snapshot":"/abs/capture.json","caption":"...","duration":3}, ...]
Terminal rows are taken verbatim from screenshot JSON; captions are outside terminal.
"""
import json,re,sys,subprocess
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
manifest=Path(sys.argv[1]); output=Path(sys.argv[2]); frames=json.loads(manifest.read_text())
fontpath='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
font=ImageFont.truetype(fontpath,17); caption_font=ImageFont.truetype(fontpath,20)
cw=font.getlength('M'); lh=24; pad=26; top=78
ansi=re.compile(r'(\x1b\[[0-9;]*[A-Za-z])'); strip=re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
base=[(15,17,23),(224,94,94),(99,190,143),(230,196,116),(112,156,225),(180,145,220),(98,193,206),(220,224,233),(105,111,126),(238,115,115),(124,213,166),(242,213,141),(144,183,242),(204,173,238),(131,216,228),(246,248,255)]
def indexed(n):
    if n<16:return base[n]
    if n>=232:return (8+(n-232)*10,)*3
    n-=16;r=n//36;g=n//6%6;b=n%6
    table=[0,95,135,175,215,255];return table[r],table[g],table[b]
def content(frame):
    data=json.loads(Path(frame['snapshot']).read_text())
    return data.get('rendered') or data['screenshot']
contents=[content(f) for f in frames]
cols=max(max(map(len,strip.sub('',s).replace('\r','').split('\n'))) for s in contents)
rows=max(len(s.replace('\r','').split('\n')) for s in contents)
width=int(cols*cw+pad*2);height=top+rows*lh+pad
width+=width%2;height+=height%2
outdir=output.parent/(output.stem+'-frames');outdir.mkdir(parents=True,exist_ok=True)
paths=[]
for i,(frame,screen) in enumerate(zip(frames,contents)):
    canvas=Image.new('RGB',(width,height),(16,19,27));draw=ImageDraw.Draw(canvas)
    draw.text((pad,22),frame.get('caption',''),font=caption_font,fill=(237,240,247))
    draw.line((pad,60,width-pad,60),fill=(63,71,88),width=1)
    fg=(220,224,233)
    for row,line in enumerate(screen.replace('\r','').split('\n')):
        col=0
        for part in ansi.split(line):
            if not part:continue
            if part.startswith('\x1b['):
                if part.endswith('m'):
                    codes=[int(c or 0) for c in part[2:-1].split(';')];j=0
                    while j<len(codes):
                        code=codes[j]
                        if code in (0,39):fg=(220,224,233)
                        elif 30<=code<=37:fg=base[code-30]
                        elif 90<=code<=97:fg=base[code-90+8]
                        elif code==38 and j+2<len(codes) and codes[j+1]==5:fg=indexed(codes[j+2]);j+=2
                        elif code==38 and j+4<len(codes) and codes[j+1]==2:fg=tuple(codes[j+2:j+5]);j+=4
                        j+=1
                continue
            draw.text((pad+col*cw,top+row*lh),part,font=font,fill=fg)
            col+=len(part)
    path=outdir/f'{i:03}.png';canvas.save(path);paths.append(path)
concat=outdir/'frames.txt'
with concat.open('w') as f:
    for path,frame in zip(paths,frames):
        f.write(f"file '{path}'\nduration {frame.get('duration',3)}\n")
    f.write(f"file '{paths[-1]}'\n")
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',str(concat),'-vf','fps=24','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(output)],check=True)
subprocess.run(['ffmpeg','-v','error','-i',str(output),'-f','null','-'],check=True)
print(json.dumps({'output':str(output),'bytes':output.stat().st_size,'frames':len(frames),'size':[width,height],'final_frame':str(paths[-1])}))

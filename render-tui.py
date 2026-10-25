import json, pathlib
from PIL import Image, ImageDraw, ImageFont
root=pathlib.Path('/tmp/allagents-588-evidence')
frames=root/'frames'; frames.mkdir(exist_ok=True)
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',20)
caption_font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',18)
cast=[json.loads(line) for line in (root/'issue-588.cast').read_text().splitlines()]
screens=[('00-main-menu',cast[1][2])]
for path in sorted((root/'screens').glob('*.txt')):
    screens.append((path.stem,path.read_text().split('Screen:\n',1)[1].rstrip('\n')))
concat=[]; capture=[json.dumps({'version':2,'width':120,'height':36,'title':'AllAgents #588 real agent-tui snapshots'})]; timestamp=0
for i,(label,screen) in enumerate(screens):
    img=Image.new('RGB',(1480,880),'#11151b'); draw=ImageDraw.Draw(img)
    draw.text((16,8),'AllAgents #588 | '+label,font=caption_font,fill='#a8d6ff')
    for row,line in enumerate(screen.splitlines()):
        draw.text((16,44+row*22),line,font=font,fill='#e4e9ef')
    path=frames/f'{i:03}.png'; img.save(path)
    duration=4 if any(term in label for term in ['detail','choices','failure','recover','review','saved','project-add','main-menu']) else 1.5
    concat.extend([f"file '{path}'",f'duration {duration}'])
    capture.append(json.dumps([timestamp,'o','\x1b[2J\x1b[H'+screen.replace('\n','\r\n')]))
    timestamp+=duration
concat.append(f"file '{path}'")
(root/'frames.txt').write_text('\n'.join(concat)+'\n')
(root/'snapshots.cast').write_text('\n'.join(capture)+'\n')
print(json.dumps({'frames':len(screens),'duration':timestamp,'method':'Real agent-tui snapshots, original terminal text; idle intervals shortened'}))

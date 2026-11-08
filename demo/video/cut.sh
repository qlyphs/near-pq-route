#!/usr/bin/env bash
# Cuts the recording into the demo video (about 60 s): real time, except the 60 s timelock wait shown 5x faster
# with a "x5" label, and the last frame held 3 s. Reads marks.json from record.mjs. Usage: bash demo/video/cut.sh <dir with raw.webm and marks.json> <out.mp4>
set -euo pipefail
dir=$1; out=$2
m() { node -e "console.log(require('$dir/marks.json').find(x=>x.name==='$1').t)"; }
start=$(node -e "console.log(Math.max(0, require('$dir/marks.json')[0].t - 0.6))")
lock=$(m timelock); exec=$(m execute); end=$(m end)
font="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
ffmpeg -loglevel error -y -i "$dir/raw.webm" -filter_complex "
[0:v]trim=$start:$lock,setpts=PTS-STARTPTS,fps=30[a];
[0:v]trim=$lock:$exec,setpts=(PTS-STARTPTS)/5,fps=30,drawtext=fontfile='$font':text='×5':fontsize=54:fontcolor=white:box=1:boxcolor=0x7aa2ffcc:boxborderw=18:x=w-tw-60:y=h-th-60[b];
[0:v]trim=$exec:$end,setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=3[c];
[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]" -map "[v]" -c:v libx264 -preset slow -crf 20 -movflags +faststart "$out"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out"

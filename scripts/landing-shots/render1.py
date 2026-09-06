#!/opt/hermes/.venv/bin/python3
"""Render the landing page at one viewport. Usage: render1.py <width> <height> <dsf> <mobile:0|1> <out.png>"""
import asyncio, sys, os, time
sys.path.insert(0, os.path.dirname(__file__))
from cdp import open_tab

URL = "http://127.0.0.1:5399/landing/index.html"

async def main():
    w, h, dsf, mobile, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == "1", sys.argv[5]
    t0 = time.time()
    tab = await open_tab(URL, width=w, height=h, dsf=dsf, mobile=mobile)
    await asyncio.sleep(2.0)
    await tab.js("document.querySelectorAll('.rv').forEach(e=>e.classList.add('in'))")
    # Force lazy images to load eagerly (no scroll dance), then poll for decode.
    await tab.js("[...document.images].forEach(i=>{i.loading='eager'; if(!i.complete){const s=i.src; i.src=''; i.src=s;}}); 1")
    for _ in range(20):
        st = await tab.js("[...document.images].filter(i=>!i.complete).length")
        if st == 0:
            break
        await asyncio.sleep(0.5)
    print("loaded", round(time.time() - t0, 1), "pending", st, flush=True)
    info = await tab.js("""JSON.stringify({
      h: document.documentElement.scrollHeight,
      broken: [...document.images].filter(i=>i.naturalWidth===0).map(i=>i.getAttribute('src')),
      overflowX: document.documentElement.scrollWidth > innerWidth,
      h1lines: Math.round(document.querySelector('h1').getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector('h1')).lineHeight)),
      wrapped: [...document.querySelectorAll('.btn')].filter(b=>b.getBoundingClientRect().height>56).map(b=>b.textContent.trim())
    })""")
    print(w, info, flush=True)
    await tab.shot(out, full_page=True)
    print("shot", round(time.time() - t0, 1), flush=True)
    await tab.__aexit__()

asyncio.run(asyncio.wait_for(main(), 80))

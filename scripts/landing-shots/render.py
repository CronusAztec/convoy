#!/opt/hermes/.venv/bin/python3
"""Render the landing page from the local static server at desktop + phone widths."""
import asyncio, sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from cdp import open_tab

URL = "http://127.0.0.1:5399/landing/index.html"

async def run(width, height, dsf, mobile, out, full=True):
    tab = await open_tab(URL, width=width, height=height, dsf=dsf, mobile=mobile)
    await asyncio.sleep(3.5)
    # force all reveals in so the full-page shot shows every section, and scroll
    # through so lazy images actually load before the capture
    await tab.js("document.querySelectorAll('.rv').forEach(e=>e.classList.add('in'))")
    await tab.js("""(async()=>{const h=document.documentElement.scrollHeight; for(let y=0;y<h;y+=Math.round(innerHeight*0.8)){scrollTo(0,y); await new Promise(r=>setTimeout(r,150));} scrollTo(0,0); return 1;})()""")
    # wait until every image has actually decoded
    await tab.js("Promise.all([...document.images].map(i=>i.complete?Promise.resolve():new Promise(r=>{i.onload=r;i.onerror=r;}))).then(()=>1)")
    await asyncio.sleep(0.8)
    info = await tab.js("""JSON.stringify({
      title: document.title,
      w: innerWidth, h: document.documentElement.scrollHeight,
      brokenImgs: [...document.images].filter(i=>!i.complete||i.naturalWidth===0).map(i=>i.getAttribute('src')),
      overflowX: document.documentElement.scrollWidth > innerWidth,
      fonts: [...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family+' '+f.weight),
      h1: document.querySelector('h1').getBoundingClientRect().height,
      h1lines: Math.round(document.querySelector('h1').getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector('h1')).lineHeight)),
      ctaTop: document.querySelector('.hero .btn-primary').getBoundingClientRect().bottom,
      wrappedBtns: [...document.querySelectorAll('.btn')].filter(b=>b.getBoundingClientRect().height>56).map(b=>b.textContent.trim()),
      navH: document.querySelector('.top .wrap').getBoundingClientRect().height
    })""")
    print(width, info)
    await tab.shot(out, full_page=full)
    await tab.__aexit__()

async def main():
    await run(1440, 900, 1, False, "/tmp/landing-desktop.png")
    await run(390, 844, 2, True, "/tmp/landing-phone.png")
    await run(1024, 768, 1, False, "/tmp/landing-tablet.png")

asyncio.run(main())

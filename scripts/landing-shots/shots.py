#!/opt/hermes/.venv/bin/python3
"""Capture the key Convoy surfaces at phone size for the landing page.

Runs against the local static copy (solo mode). Riders are seeded through the same
A.sim.remoteAdd() path the live server uses, so the map/nearby/convoy surfaces show
real product rendering. No third-party quota is used beyond CARTO basemap tiles.
"""
import asyncio, json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from cdp import open_tab

OUT = "/opt/data/convoy/scripts/landing-shots/out"
os.makedirs(OUT, exist_ok=True)

RIDERS = """(()=>{
  const me = App.sim.playerPos();
  const mk = (id, name, handle, car, dx, dy, heading) => ({
    id, name, handle, emoji: (id.charCodeAt(1)%8), vibe: 'Cruising', car,
    pos: [me[0]+dx, me[1]+dy], heading, speed: 12, mode: 'cruise'
  });
  const riders = [
    mk('r1','Mara','mara',{year:2021,make:'Mazda',model:'MX-5',trim:'',paint:'#c9302c',paintName:'Soul Red',finish:'Gloss'}, 0.0031, 0.0012, 95),
    mk('r2','Dev','devk',{year:2019,make:'Honda',model:'Civic Type R',trim:'',paint:'#e8e8e8',paintName:'Championship White',finish:'Gloss'}, -0.0024, 0.0021, 270),
    mk('r3','Sofia','sofia.r',{year:2023,make:'Hyundai',model:'Ioniq 5 N',trim:'',paint:'#6b8ea5',paintName:'Performance Blue',finish:'Matte'}, 0.0009, -0.0027, 10),
    mk('r4','Theo','theo',{year:2018,make:'Ford',model:'Mustang GT',trim:'',paint:'#1d1f22',paintName:'Shadow Black',finish:'Gloss'}, -0.0041, -0.0009, 180),
    mk('r5','Ines','ines',{year:2020,make:'BMW',model:'M240i',trim:'',paint:'#f2b632',paintName:'Sunset Orange',finish:'Metallic'}, 0.0052, 0.0038, 220),
    mk('r6','Kofi','kofi',{year:2016,make:'Subaru',model:'WRX STI',trim:'',paint:'#2f6df6',paintName:'WR Blue',finish:'Gloss'}, -0.0012, 0.0044, 130),
  ];
  riders.forEach(r => App.sim.remoteAdd(r));
  return 'seeded '+App.sim.count();
})()"""

async def click_text(tab, text, exact=False):
    return await tab.js(f"""(()=>{{
      const t={json.dumps(text)};
      const els=[...document.querySelectorAll('button, [role=button], a, label')].filter(e=>e.offsetParent);
      const el=els.find(e=>{{const s=(e.innerText||e.getAttribute('aria-label')||'').trim(); return {'s===t' if exact else 's.toLowerCase().includes(t.toLowerCase())'};}});
      if(!el) return 'NOT FOUND: '+t;
      el.click(); return 'clicked '+ (el.id||el.className.toString().slice(0,30)) + ' :: ' + (el.innerText||'').trim().slice(0,40);
    }})()""")

async def click_sel(tab, sel):
    return await tab.js(f"(()=>{{const el=document.querySelector({json.dumps(sel)}); if(!el) return 'NOT FOUND {sel}'; el.click(); return 'clicked {sel}';}})()")

async def visible_text(tab, n=500):
    return await tab.js(f"document.body.innerText.slice(0,{n}).replace(/\\n+/g,' | ')")

async def settle_map(tab, secs=6):
    await asyncio.sleep(secs)
    return await tab.js("(()=>{try{const m=App.mapview.map(); return JSON.stringify({z:+m.getZoom().toFixed(2), tiles:m.areTilesLoaded()});}catch(e){return String(e)}})()")

async def boot(tab):
    await asyncio.sleep(7)
    print(await click_text(tab, "Continue as guest"))
    await asyncio.sleep(1.2)
    await tab.js("(()=>{[...document.querySelectorAll('.consent-row input[type=checkbox]')].forEach(c=>c.click()); return 1})()")
    await asyncio.sleep(0.3)
    print(await click_text(tab, "Start riding"))
    await asyncio.sleep(3)
    # Land the globe intro on the demo city at street level (what a real GPS fix does).
    print(await tab.js("(()=>{const p=App.sim.playerPos(); return 'land '+App.mapview.landIntro(p, 15.2);})()"))
    await asyncio.sleep(5.5)
    print(await tab.js(RIDERS))
    print("settle", await settle_map(tab, 5))

async def main():
    which = sys.argv[1:] or ["map", "nearby", "convoy", "radar", "profile", "route"]
    tab = await open_tab("http://127.0.0.1:5399/index.html")
    await boot(tab)

    if "map" in which:
        await tab.shot(f"{OUT}/10-map-riders.png")

    if "nearby" in which:
        print(await click_sel(tab, '[data-dock="nearby"]'))
        await asyncio.sleep(3.5)  # let invite toasts clear
        await asyncio.sleep(1.2)
        await tab.shot(f"{OUT}/11-nearby.png")

    if "convoy" in which:
        print(await tab.js("(()=>{App.party.create('Friday night cruise', 3); return 'created';})()"))
        await asyncio.sleep(0.5)
        print(await tab.js("(()=>{['r1','r3','r5'].forEach(id=>App.party.invite(id)); return 'invited';})()"))
        await asyncio.sleep(3.5)
        print(await tab.js("""(()=>{
          const say=(from,text)=>App.party.pushChat({from, text, t: Date.now()});
          say('Mara','taking the coast road, less traffic'); say('Sofia','copy, staying behind you'); say('me','rally at the pier lot in 10');
          return 'chat '+(App.state.party.chat.length);})()"""))
        await asyncio.sleep(0.6)
        print(await click_sel(tab, '[data-dock="convoy"]'))
        await asyncio.sleep(0.5)
        print(await tab.js("(()=>{App.store.emit('party'); App.store.emit('chat'); return JSON.stringify({party:App.state.party&&App.state.party.name, members:App.state.party&&App.state.party.members, sub:document.getElementById('convoy-sub').textContent, body:document.getElementById('convoy-body').innerText.slice(0,200)});})()"))
        await asyncio.sleep(4.5)  # let toasts clear
        await tab.shot(f"{OUT}/12-convoy.png")
        print(await click_sel(tab, '[data-dock="map"]'))
        await asyncio.sleep(1.2)
        await tab.shot(f"{OUT}/13-convoy-map.png")

    if "radar" in which:
        print(await click_sel(tab, "#ctl-ghost"))
        await asyncio.sleep(1.5)
        # accept the legality notice if it appeared
        print(await click_text(tab, "Turn on"), await click_text(tab, "I understand"), await click_text(tab, "Enable"))
        await asyncio.sleep(3)
        print("radar text:", await visible_text(tab, 400))
        await tab.shot(f"{OUT}/14-radar.png")
        print(await click_sel(tab, "#ctl-ghost"))
        await asyncio.sleep(1)

    if "profile" in which:
        print(await click_sel(tab, '[data-dock="profile"]'))
        await asyncio.sleep(1.2)
        await tab.shot(f"{OUT}/15-profile.png")
        print(await click_text(tab, "My Garage"))
        await asyncio.sleep(1.5)
        await tab.shot(f"{OUT}/16-garage.png")
        print(await click_text(tab, "Back"))
        await asyncio.sleep(0.5)
        print(await click_sel(tab, '[data-dock="map"]'))
        await asyncio.sleep(0.8)

    if "route" in which:
        # Route to a point ~4 km away (OSRM public demo; a single request).
        print(await tab.js("(()=>{const p=App.sim.playerPos(); App.routing.setDestination([p[0]+0.035, p[1]+0.018], 'Griffith Observatory'); return 'routing';})()"))
        await asyncio.sleep(6)
        print("route:", await tab.js("JSON.stringify(App.state.route && {d:App.state.route.distance, t:App.state.route.duration, n:App.state.route.coords.length})"))
        await tab.shot(f"{OUT}/17-route.png")
        print(await tab.js("(()=>{try{App.routing.startTrip({mult:5}); return 'trip';}catch(e){return String(e)}})()"))
        await asyncio.sleep(7)
        print("trip:", await visible_text(tab, 300))
        await tab.shot(f"{OUT}/18-trip.png")

    await tab.__aexit__()

asyncio.run(main())

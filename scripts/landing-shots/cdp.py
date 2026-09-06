#!/opt/hermes/.venv/bin/python3
"""Minimal CDP driver for the GL-capable Chrome on :9223 (screenshots for the landing page)."""
import asyncio, base64, json, sys, time, urllib.request
import websockets

CDP = "http://127.0.0.1:9223"

def _get(path):
    with urllib.request.urlopen(CDP + path, timeout=5) as r:
        return json.loads(r.read())

def new_target(url="about:blank"):
    req = urllib.request.Request(CDP + "/json/new?" + urllib.parse.quote(url, safe=":/?=&"), method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())

import urllib.parse

class Tab:
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self.ws = None
        self._id = 0
        self._events = []

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ws_url, max_size=64 * 1024 * 1024)
        return self

    async def __aexit__(self, *a):
        try:
            await self.send("Page.close")
        except Exception:
            pass
        await self.ws.close()

    async def send(self, method, **params):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
            else:
                self._events.append(msg)

    async def js(self, expr, await_promise=True):
        r = await self.send("Runtime.evaluate", expression=expr, awaitPromise=await_promise, returnByValue=True)
        if "exceptionDetails" in r:
            return {"__error": r["exceptionDetails"].get("exception", {}).get("description", str(r["exceptionDetails"]))}
        return r.get("result", {}).get("value")

    async def shot(self, path, full_page=False):
        params = {"format": "png"}
        if full_page:
            m = await self.send("Page.getLayoutMetrics")
            cs = m["cssContentSize"]
            params["captureBeyondViewport"] = True
            params["clip"] = {"x": 0, "y": 0, "width": cs["width"], "height": cs["height"], "scale": 1}
        r = await self.send("Page.captureScreenshot", **params)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path

async def open_tab(url, width=390, height=844, dsf=2, mobile=True):
    t = new_target("about:blank")
    tab = Tab(t["webSocketDebuggerUrl"])
    await tab.__aenter__()
    await tab.send("Page.enable")
    await tab.send("Runtime.enable")
    await tab.send("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=dsf, mobile=mobile)
    if mobile:
        await tab.send("Emulation.setTouchEmulationEnabled", enabled=True)
    await tab.send("Page.navigate", url=url)
    return tab

if __name__ == "__main__":
    async def main():
        tab = await open_tab(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5399/index.html")
        await asyncio.sleep(8)
        print(await tab.js("JSON.stringify({title:document.title, webgl:(()=>{try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'))}catch(e){return String(e)}})(), hasMap:(()=>{try{return !!App.mapview.map()}catch(e){return String(e)}})()})"))
        print(await tab.shot("/tmp/shot-gl.png"))
        await tab.__aexit__()
    asyncio.run(main())

import { z } from "zod";
export const starterSchema = z.enum(["website", "dashboard", "internal-tool", "blank"]);
export type Starter = z.infer<typeof starterSchema>;
export const starterLabels: Record<Starter, string> = {
	website: "Website",
	dashboard: "Dashboard",
	"internal-tool": "Internal tool",
	blank: "Blank workspace",
};
/** Blank placeholder: a full-page whiteboard the user can sketch on until the app is built. */
const whiteboardHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Whiteboard</title><style>html,body{margin:0;height:100%;overflow:hidden;background:#f8fafc;font:14px system-ui;color:#172033}canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}#hint{position:fixed;inset:0;display:grid;place-items:center;pointer-events:none;color:#94a3b8;font-size:clamp(1.25rem,3vw,2rem);transition:opacity .3s}#tools{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;padding:8px;background:white;border:1px solid #cbd5e1;border-radius:999px;box-shadow:0 4px 16px rgba(15,23,42,.08)}#tools button{width:28px;height:28px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}#clear{width:auto!important;border-radius:999px!important;padding:0 12px!important;background:#f1f5f9;color:#172033;font:inherit}</style><canvas id="board" aria-label="Whiteboard"></canvas><div id="hint">Your app here</div><div id="tools"><button id="clear">Clear</button></div><script>
const canvas=document.getElementById("board"),ctx=canvas.getContext("2d"),hint=document.getElementById("hint");
let last=null;
function resize(){const copy=document.createElement("canvas");copy.width=canvas.width;copy.height=canvas.height;copy.getContext("2d").drawImage(canvas,0,0);const r=devicePixelRatio||1;canvas.width=innerWidth*r;canvas.height=innerHeight*r;ctx.setTransform(r,0,0,r,0,0);ctx.lineCap=ctx.lineJoin="round";ctx.drawImage(copy,0,0,copy.width/r,copy.height/r);}
resize();addEventListener("resize",resize);
canvas.addEventListener("pointerdown",e=>{canvas.setPointerCapture(e.pointerId);last={x:e.clientX,y:e.clientY};hint.style.opacity=0;draw(e);});
canvas.addEventListener("pointermove",e=>{if(last)draw(e);});
for(const t of["pointerup","pointercancel"])canvas.addEventListener(t,()=>{last=null;});
function draw(e){ctx.strokeStyle="#172033";ctx.lineWidth=3*(e.pressure&&e.pointerType==="pen"?e.pressure*2:1);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(e.clientX,e.clientY);ctx.stroke();last={x:e.clientX,y:e.clientY};}
document.getElementById("clear").addEventListener("click",()=>{ctx.clearRect(0,0,canvas.width,canvas.height);hint.style.opacity=1;});
</script></html>`;

/** Small deterministic starters: no model call, external assets, or deployment. */
export function starterFiles(kind: Starter): Record<string, string> {
	const title = starterLabels[kind];
	const content =
		kind === "website"
			? "<nav>Home · About · Contact</nav><h1>Your next great idea starts here.</h1><p>Build a website that tells your story.</p><button>Get started</button>"
			: kind === "dashboard"
				? "<h1>Dashboard</h1><section><article><h2>Revenue</h2><p>—</p></article><article><h2>Customers</h2><p>—</p></article><article><h2>Orders</h2><p>—</p></article></section><p>Connect your data with your assistant.</p>"
				: kind === "internal-tool"
					? "<h1>Team workspace</h1><table><thead><tr><th>Task</th><th>Owner</th><th>Status</th></tr></thead><tbody><tr><td>Set up your workflow</td><td>Your team</td><td>Ready</td></tr></tbody></table>"
					: "";
	const html =
		kind === "blank"
			? whiteboardHtml
			: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;margin:0;padding:5vw;color:#172033;background:#f8fafc}main{max-width:1000px;margin:auto}h1{font-size:clamp(2rem,5vw,4rem)}section{display:flex;gap:24px;flex-wrap:wrap}article{padding:24px;background:white;border:1px solid #cbd5e1;border-radius:12px;min-width:180px}button{padding:12px 24px;background:#3730a3;color:white;border:0;border-radius:6px}td,th{padding:16px;text-align:left;border-bottom:1px solid #cbd5e1}</style><main>${content}</main></html>`;
	return {
		"wrangler.json": JSON.stringify(
			{ name: "laplace-app", main: "src/index.ts", compatibility_date: "2026-05-23" },
			null,
			2,
		),
		"src/index.ts": `import { DurableObject } from "cloudflare:workers";\nexport class App extends DurableObject {\n async fetch(request: Request) {\n if (new URL(request.url).pathname === "/__laplace/health") return new Response("ok");\n return new Response(${JSON.stringify(html)}, {headers: {"content-type":"text/html; charset=utf-8"}});\n }\n}\n`,
	};
}

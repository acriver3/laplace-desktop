import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { PointRect } from "../shared/point-contracts";

import "./point-overlay.css";

declare global {
	interface Window {
		laplacePoint: {
			initialize(): Promise<{ image: string; destination: string }>;
			select(rect: PointRect): Promise<void>;
			cancel(): Promise<void>;
		};
	}
}

function Overlay() {
	const [image, setImage] = useState("");
	const [destination, setDestination] = useState("Codex");
	const [rect, setRect] = useState<PointRect>();
	const [error, setError] = useState<string>();
	const start = useRef<{ x: number; y: number } | undefined>(undefined);
	const submitting = useRef(false);
	useEffect(() => {
		void window.laplacePoint
			.initialize()
			.then((data) => {
				setImage(data.image);
				setDestination(data.destination);
			})
			.catch(() => setError("Capture unavailable. Press Escape to close."));
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") void window.laplacePoint.cancel();
		};
		window.addEventListener("keydown", escape);
		return () => window.removeEventListener("keydown", escape);
	}, []);
	const selection = (x: number, y: number) => {
		const from = start.current!;
		x = Math.max(0, Math.min(innerWidth, x));
		y = Math.max(0, Math.min(innerHeight, y));
		return {
			x: Math.min(from.x, x),
			y: Math.min(from.y, y),
			width: Math.abs(x - from.x),
			height: Math.abs(y - from.y),
		};
	};
	return (
		<main
			className="point-overlay"
			aria-label="Select a screenshot region"
			onPointerDown={(event) => {
				if (!image || event.button !== 0 || submitting.current) return;
				event.currentTarget.setPointerCapture(event.pointerId);
				start.current = { x: event.clientX, y: event.clientY };
				setError(undefined);
				setRect(undefined);
			}}
			onPointerMove={(event) => {
				if (start.current && !submitting.current) setRect(selection(event.clientX, event.clientY));
			}}
			onPointerUp={(event) => {
				if (!start.current || submitting.current) return;
				const selected = selection(event.clientX, event.clientY);
				start.current = undefined;
				if (selected.width < 2 || selected.height < 2) {
					setRect(undefined);
					return;
				}
				submitting.current = true;
				void window.laplacePoint.select(selected).catch((reason: Error) => {
					setError(reason.message);
					submitting.current = false;
				});
			}}
			onPointerCancel={() => {
				start.current = undefined;
				setRect(undefined);
			}}
		>
			{image && <img className="point-screen" src={image} alt="Frozen screen" draggable={false} />}
			{rect ? (
				<div
					className="point-selection"
					style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
				/>
			) : (
				<div className="point-shade" />
			)}
			<div className="point-hint">
				<strong>Laplace Point</strong>
				<span>{error ?? "Drag to snip · Escape to cancel"}</span>
				<small>{destination}</small>
			</div>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Overlay />);

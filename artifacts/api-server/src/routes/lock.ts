import { and, eq, isNull, lte, or } from "drizzle-orm";
import { Router, type IRouter, type RequestHandler } from "express";
import { HeartbeatLockBody, ReleaseLockBody } from "@workspace/api-zod";
import { db, operationLocks } from "@workspace/db";

const router: IRouter = Router();
const leaseDurationMs = 30_000;
const sessionPattern = /^[a-zA-Z0-9_-]{12,100}$/;

function readSessionId(value: unknown): string | null {
	return typeof value === "string" && sessionPattern.test(value) ? value : null;
}

async function lockState(sessionId: string) {
	const [lease] = await db.select().from(operationLocks).where(eq(operationLocks.id, 1)).limit(1);
	const active = Boolean(lease?.ownerSessionId && lease.expiresAt && lease.expiresAt.getTime() > Date.now());
	return {
		locked: active && lease?.ownerSessionId !== sessionId,
		heldByThisClient: active && lease?.ownerSessionId === sessionId,
		expiresAt: active && lease?.expiresAt ? lease.expiresAt.toISOString() : null,
	};
}

router.get("/lock", async (req, res, next): Promise<void> => {
	try {
		const sessionId = readSessionId(req.query.sessionId);
		if (!sessionId) {
			res.status(400).json({ message: "sessionId inválido." });
			return;
		}
		res.json(await lockState(sessionId));
	} catch (error) {
		next(error);
	}
});

router.post("/lock/heartbeat", async (req, res, next): Promise<void> => {
	try {
		const parsed = HeartbeatLockBody.safeParse(req.body);
		if (!parsed.success || !readSessionId(parsed.success ? parsed.data.sessionId : null)) {
			res.status(400).json({ message: "sessionId inválido." });
			return;
		}
		const sessionId = parsed.data.sessionId;
		const now = new Date();
		await db
			.insert(operationLocks)
			.values({
				id: 1,
				ownerSessionId: sessionId,
				expiresAt: new Date(now.getTime() + leaseDurationMs),
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: operationLocks.id,
				set: {
					ownerSessionId: sessionId,
					expiresAt: new Date(now.getTime() + leaseDurationMs),
					updatedAt: now,
				},
				setWhere: or(
					isNull(operationLocks.ownerSessionId),
					isNull(operationLocks.expiresAt),
					lte(operationLocks.expiresAt, now),
					eq(operationLocks.ownerSessionId, sessionId),
				),
			});
		res.json(await lockState(sessionId));
	} catch (error) {
		next(error);
	}
});

router.post("/lock/release", async (req, res, next): Promise<void> => {
	try {
		const parsed = ReleaseLockBody.safeParse(req.body);
		if (!parsed.success || !readSessionId(parsed.success ? parsed.data.sessionId : null)) {
			res.status(400).json({ message: "sessionId inválido." });
			return;
		}
		const sessionId = parsed.data.sessionId;
		await db
			.update(operationLocks)
			.set({ ownerSessionId: null, expiresAt: null, updatedAt: new Date() })
			.where(and(eq(operationLocks.id, 1), eq(operationLocks.ownerSessionId, sessionId)));
		res.json(await lockState(sessionId));
	} catch (error) {
		next(error);
	}
});

export const requireDemoLease: RequestHandler = async (req, res, next): Promise<void> => {
	if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method.toUpperCase())) {
		next();
		return;
	}
	const sessionId = readSessionId(req.header("x-demo-session"));
	if (!sessionId) {
		res.status(428).json({ message: "A sessão de demonstração ainda não está ativa." });
		return;
	}
	try {
		const state = await lockState(sessionId);
		if (!state.heldByThisClient) {
			res.status(423).json({
				message: state.locked
					? "Sistema em uso por outro usuário."
					: "A sessão de edição expirou. Atualize a página para retomar.",
			});
			return;
		}
		next();
	} catch (error) {
		next(error);
	}
};

export default router;

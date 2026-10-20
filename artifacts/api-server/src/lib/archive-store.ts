import { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot } from "./storage";

/**
 * Archive keys are POSIX-style paths relative to the data root (for example
 * "Folhas_2026-09/Maria_Silva-2026-09.pdf"). The database stores the key
 * instead of an absolute path so rows stay valid when the data folder moves
 * between machines and so the same row works for filesystem and bucket modes.
 */
export type ArchiveStore = {
	exists(key: string): Promise<boolean>;
	read(key: string): Promise<Buffer | null>;
	write(key: string, data: Buffer): Promise<void>;
	move(fromKey: string, toKey: string): Promise<void>;
	remove(key: string): Promise<void>;
};

function keySegments(key: string): string[] | null {
	if (!key) return null;
	const segments = key.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
	return segments;
}

/**
 * Accepts what the database may contain: a new-style key, or a legacy absolute
 * path from the portable filesystem era. Legacy paths outside the data root
 * are rejected (a moved or foreign folder must never be read or rewritten).
 */
export function toArchiveKey(stored: string | null | undefined, root = dataRoot()): string | null {
	if (!stored) return null;
	let candidate = stored;
	if (path.isAbsolute(candidate)) {
		const relative = path.relative(root, candidate);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
		candidate = relative;
	}
	candidate = candidate.split(path.sep).join("/").split("\\").join("/");
	return keySegments(candidate) ? candidate : null;
}

function localPath(root: string, key: string): string {
	const segments = keySegments(key);
	if (!segments) throw new Error(`Chave de arquivo inválida: ${key}`);
	return path.join(root, ...segments);
}

export function fsArchiveStore(root: string): ArchiveStore {
	return {
		async exists(key) {
			return fs
				.access(localPath(root, key))
				.then(() => true)
				.catch(() => false);
		},
		async read(key) {
			return fs.readFile(localPath(root, key)).catch(() => null);
		},
		async write(key, data) {
			const target = localPath(root, key);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, data);
		},
		async move(fromKey, toKey) {
			const from = localPath(root, fromKey);
			const to = localPath(root, toKey);
			await fs.mkdir(path.dirname(to), { recursive: true });
			await fs.rename(from, to);
		},
		async remove(key) {
			await fs.rm(localPath(root, key), { force: true }).catch(() => undefined);
		},
	};
}

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

export function s3ArchiveStore(client: S3Client, bucket: string): ArchiveStore {
	// HeadObject/GetObject signal "missing" differently across S3-compatible
	// services (R2, MinIO, S3), so every 404-ish shape maps to "not found".
	const isNotFound = (error: unknown): boolean => {
		const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
		const name = (error as { name?: string })?.name;
		return status === 404 || name === "NotFound" || name === "NoSuchKey";
	};
	return {
		async exists(key) {
			try {
				await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return true;
			} catch (error) {
				if (isNotFound(error)) return false;
				throw error;
			}
		},
		async read(key) {
			try {
				const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
				const body = response.Body;
				if (!body || typeof body.transformToByteArray !== "function") return null;
				return Buffer.from(await body.transformToByteArray());
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		async write(key, data) {
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: "application/pdf" }),
			);
		},
		async move(fromKey, toKey) {
			// S3 has no rename: a server-side copy followed by the source delete
			// keeps the "_OLD is never deleted" convention working everywhere.
			await client.send(
				new CopyObjectCommand({ Bucket: bucket, CopySource: `/${bucket}/${encodeKey(fromKey)}`, Key: toKey }),
			);
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
		},
		async remove(key) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		},
	};
}

type S3Config = { bucket: string; endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string };

/** Missing variables keep the filesystem driver: the portable setup stays the default. */
function s3ConfigFromEnv(): S3Config | null {
	const bucket = process.env.S3_BUCKET?.trim();
	const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
	if (!bucket || !accessKeyId || !secretAccessKey) return null;
	const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
	// R2/MinIO accept "auto"; AWS S3 needs a real region, so only default to
	// "auto" when a custom endpoint is in play.
	const region = process.env.S3_REGION?.trim() || (endpoint ? "auto" : "us-east-1");
	return { bucket, endpoint, region, accessKeyId, secretAccessKey };
}

let cachedStore: ArchiveStore | null = null;

export function archiveStore(): ArchiveStore {
	if (!cachedStore) {
		const config = s3ConfigFromEnv();
		if (config) {
			const client = new S3Client({
				region: config.region,
				endpoint: config.endpoint,
				// Custom endpoints (R2, MinIO) require bucket-in-path addressing.
				forcePathStyle: Boolean(config.endpoint),
				credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
			});
			cachedStore = s3ArchiveStore(client, config.bucket);
		} else {
			cachedStore = fsArchiveStore(dataRoot());
		}
	}
	return cachedStore;
}

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

function secretKey(purpose: string): Buffer {
	const secret = process.env.SESSION_SECRET;
	if (!secret) throw new Error("SESSION_SECRET must be configured to protect demonstration data.");
	return createHash("sha256").update(`ponto-digital:${purpose}:${secret}`).digest();
}

export function normalizeCpf(value: unknown): string {
	return String(value ?? "").replace(/\D/g, "");
}

export function cpfHash(value: unknown): string | null {
	const digits = normalizeCpf(value);
	if (digits.length !== 11) return null;
	return createHmac("sha256", secretKey("cpf-search")).update(digits).digest("hex");
}

export function maskCpf(lastDigits: string | null | undefined): string {
	return lastDigits ? `***.***.***-${lastDigits}` : "***.***.***-**";
}

export function encryptSecret(value: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", secretKey("smtp-encryption"), iv);
	const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(value: string | null | undefined): string | null {
	if (!value) return null;
	const [version, ivHex, tagHex, ciphertext] = value.split(":");
	if (version !== "v1" || !ivHex || !tagHex || !ciphertext) {
		throw new Error("Stored SMTP secret has an unsupported format.");
	}
	const decipher = createDecipheriv("aes-256-gcm", secretKey("smtp-encryption"), Buffer.from(ivHex, "hex"));
	decipher.setAuthTag(Buffer.from(tagHex, "hex"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

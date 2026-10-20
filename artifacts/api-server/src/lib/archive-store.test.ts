import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fsArchiveStore, s3ArchiveStore, toArchiveKey } from "./archive-store";

describe("fsArchiveStore", () => {
	it("escreve, lê, move e remove usando chaves com barra", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "ponto-store-"));
		const store = fsArchiveStore(root);
		const key = "Folhas_2026-09/Maria_Silva-2026-09.pdf";
		try {
			await store.write(key, Buffer.from("conteudo"));
			assert.equal(await store.exists(key), true);
			assert.deepEqual(await store.read(key), Buffer.from("conteudo"));

			const backupKey = "Folhas_2026-09/Maria_Silva-2026-09_OLD_20261020-101500.pdf";
			await store.move(key, backupKey);
			assert.equal(await store.exists(key), false);
			assert.deepEqual(await store.read(backupKey), Buffer.from("conteudo"));

			await store.remove(backupKey);
			assert.equal(await store.exists(backupKey), false);
			assert.equal(await store.read(backupKey), null);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("recusa chaves com travessia de diretório", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "ponto-store-"));
		const store = fsArchiveStore(root);
		try {
			await assert.rejects(() => store.write("../fora.pdf", Buffer.from("x")));
			await assert.rejects(() => store.write("Folhas_2026-09/../../fora.pdf", Buffer.from("x")));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("toArchiveKey", () => {
	const root = path.resolve(path.join(os.tmpdir(), "ponto-raiz"));

	it("aceita chave nova no formato POSIX", () => {
		assert.equal(toArchiveKey("Folhas_2026-09/Maria-2026-09.pdf", root), "Folhas_2026-09/Maria-2026-09.pdf");
	});

	it("converte caminho legado absoluto dentro da raiz em chave", () => {
		const legacy = path.join(root, "Folhas_2026-09", "Maria-2026-09.pdf");
		assert.equal(toArchiveKey(legacy, root), "Folhas_2026-09/Maria-2026-09.pdf");
	});

	it("rejeita caminho legado fora da raiz e valores vazios", () => {
		assert.equal(toArchiveKey(path.join(os.tmpdir(), "outro", "x.pdf"), root), null);
		assert.equal(toArchiveKey("..", root), null);
		assert.equal(toArchiveKey("", root), null);
		assert.equal(toArchiveKey(null, root), null);
	});

	it("rejeita chaves com travessia", () => {
		assert.equal(toArchiveKey("Folhas_2026-09/../../etc/passwd", root), null);
		assert.equal(toArchiveKey("../secrets.pdf", root), null);
	});
});

type SentCommand = { name: string; input: Record<string, unknown> };

function fakeS3Client(handler?: (command: SentCommand) => Record<string, unknown> | undefined) {
	const sent: SentCommand[] = [];
	const client = {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			const entry = { name: command.constructor.name, input: command.input };
			sent.push(entry);
			return handler?.(entry) ?? {};
		},
	};
	return { sent, client: client as unknown as Parameters<typeof s3ArchiveStore>[0] };
}

describe("s3ArchiveStore", () => {
	it("write envia PutObject com bucket, chave e corpo", async () => {
		const { sent, client } = fakeS3Client();
		const store = s3ArchiveStore(client, "ponto-digital");
		await store.write("Folhas_2026-09/Maria-2026-09.pdf", Buffer.from("pdf"));
		assert.equal(sent.length, 1);
		assert.equal(sent[0].name, "PutObjectCommand");
		assert.equal(sent[0].input.Bucket, "ponto-digital");
		assert.equal(sent[0].input.Key, "Folhas_2026-09/Maria-2026-09.pdf");
		assert.equal(sent[0].input.ContentType, "application/pdf");
	});

	it("exists trata 404 como ausente e outros erros como falha", async () => {
		const missing = fakeS3Client(() => {
			throw { name: "NotFound", $metadata: { httpStatusCode: 404 } };
		});
		assert.equal(await s3ArchiveStore(missing.client, "b").exists("x.pdf"), false);

		const broken = fakeS3Client(() => {
			throw { name: "AccessDenied", $metadata: { httpStatusCode: 403 } };
		});
		await assert.rejects(() => s3ArchiveStore(broken.client, "b").exists("x.pdf"));
	});

	it("move copia e depois apaga a origem (S3 não tem rename)", async () => {
		const { sent, client } = fakeS3Client();
		const store = s3ArchiveStore(client, "ponto-digital");
		await store.move("Folhas_2026-09/Maria Silva.pdf", "Folhas_2026-09/Maria Silva_OLD_1.pdf");
		assert.deepEqual(
			sent.map((command) => command.name),
			["CopyObjectCommand", "DeleteObjectCommand"],
		);
		// Segmentos da chave precisam ser URI-encoding (espaços, acentos).
		assert.equal(sent[0].input.CopySource, "/ponto-digital/Folhas_2026-09/Maria%20Silva.pdf");
		assert.equal(sent[1].input.Key, "Folhas_2026-09/Maria Silva.pdf");
	});

	it("read devolve os bytes e null quando o objeto não existe", async () => {
		const ok = fakeS3Client(() => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }));
		assert.deepEqual(await s3ArchiveStore(ok.client, "b").read("x.pdf"), Buffer.from([1, 2, 3]));

		const missing = fakeS3Client(() => {
			throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
		});
		assert.equal(await s3ArchiveStore(missing.client, "b").read("x.pdf"), null);
	});

	it("remove envia DeleteObject", async () => {
		const { sent, client } = fakeS3Client();
		await s3ArchiveStore(client, "b").remove("x.pdf");
		assert.equal(sent[0].name, "DeleteObjectCommand");
	});
});

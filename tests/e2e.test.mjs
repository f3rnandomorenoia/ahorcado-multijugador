import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import roomHandler from "../netlify/functions/room.mjs";

const PUBLIC_DIR = new URL("../public/", import.meta.url);
const CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

test("two browser players can join, take turns, finish, and reset a game", async () => {
  await withApp(async ({ baseUrl, store }) => {
    await withBrowser(async (browser) => {
      const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();

      await host.goto(baseUrl);
      await host.fill("#playerName", "Fernando");
      await host.click("#createRoom");
      await host.waitForSelector("#game:not(.hidden)");
      const roomId = await text(host, "#roomId");
      await forceRoom(store, roomId, (room) => {
        room.word = "casa";
        room.guessedLetters = [];
        room.wrongLetters = [];
        room.status = "playing";
        room.lastMove = null;
      });

      await guest.goto(`${baseUrl}/?sala=${roomId}`);
      await guest.fill("#playerName", "Migue");
      await guest.click("#joinRoom");
      await guest.waitForSelector("#game:not(.hidden)");

      await waitText(host, "#statusDetail", /2\/2 jugadores/);
      await assertNoHorizontalOverflow(host);
      await assertNoHorizontalOverflow(guest);

      await clickLetter(host, "a");
      await waitText(host, "#lastMove", /Fernando: A acierta/);
      assert.equal(await aria(host, "#word"), "Palabra: _a_a");
      await waitText(host, "#statusTitle", /^Tu turno$/);
      assert.equal(await statFor(host, "Fernando", "Aciertos"), "1");

      await clickLetter(host, "x");
      await waitText(host, "#statusTitle", /Turno de Migue/);
      await waitText(guest, "#statusTitle", /^Tu turno$/);
      await waitText(guest, "#lastMove", /Fernando: X falla/);
      assert.equal(await statFor(guest, "Fernando", "Avisos"), "1");
      assert.equal(await isLetterDisabled(host, "c"), true);

      await clickLetter(guest, "c");
      await waitText(guest, "#lastMove", /Migue: C acierta/);
      assert.equal(await aria(guest, "#word"), "Palabra: ca_a");
      await waitText(guest, "#statusTitle", /^Tu turno$/);
      assert.equal(await statFor(guest, "Migue", "Aciertos"), "1");

      await clickLetter(guest, "z");
      await waitText(guest, "#statusTitle", /Turno de Fernando/);
      await waitText(host, "#statusTitle", /^Tu turno$/);
      assert.equal(await statFor(host, "Migue", "Avisos"), "1");

      await clickLetter(host, "s");
      await waitText(host, "#endTitle", /Gana Fernando/);
      await waitText(guest, "#endTitle", /Gana Fernando/);
      await waitText(host, "#answer", /Palabra: casa/);
      assert.equal(await statFor(host, "Fernando", "Aciertos"), "2");

      await host.click("#newRound");
      await waitText(host, "#statusTitle", /^Tu turno$/);
      await waitText(host, "#misses", /^0$/);
      assert.equal(await text(host, "#answer"), "");
      assert.equal(await statFor(host, "Fernando", "Aciertos"), "0");

      await hostContext.close();
      await guestContext.close();
    });
  });
});

test("shared room links handle mobile entry, focus, and auto-join with saved names", async () => {
  await withApp(async ({ baseUrl }) => {
    await withBrowser(async (browser) => {
      const created = await postJson(`${baseUrl}/api/room`, { action: "create", playerName: "Fernando" });
      const roomId = created.room.id;

      const cleanContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const cleanPage = await cleanContext.newPage();
      await cleanPage.goto(`${baseUrl}/?sala=${roomId}`);
      assert.equal(await inputValue(cleanPage, "#roomCode"), roomId);
      assert.equal(await cleanPage.evaluate(() => document.activeElement?.id), "playerName");
      await assertNoHorizontalOverflow(cleanPage);
      await cleanContext.close();

      const returningContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
      const returningPage = await returningContext.newPage();
      await returningPage.goto(baseUrl);
      await returningPage.evaluate(() => localStorage.setItem("ahorcado.playerName", "Migue"));
      await returningPage.goto(`${baseUrl}/?sala=${roomId}`);
      await returningPage.waitForSelector("#game:not(.hidden)");
      await waitText(returningPage, "#roomId", new RegExp(roomId));
      assert.equal(await statFor(returningPage, "Migue", "Aciertos"), "0");
      await assertNoHorizontalOverflow(returningPage);
      await returningContext.close();
    });
  });
});

async function withApp(run) {
  const previousStore = process.env.LOCAL_ROOM_STORE;
  const store = await mkdtemp(join(tmpdir(), "ahorcado-e2e-"));
  process.env.LOCAL_ROOM_STORE = store;

  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/api/room") || request.url?.startsWith("/.netlify/functions/room")) {
        await proxyFunction(request, response);
        return;
      }
      await serveStatic(request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.stack || error.message);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, store });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousStore === undefined) {
      delete process.env.LOCAL_ROOM_STORE;
    } else {
      process.env.LOCAL_ROOM_STORE = previousStore;
    }
    await rm(store, { recursive: true, force: true });
  }
}

async function withBrowser(run) {
  const executablePath = await firstExistingPath(CHROME_CANDIDATES);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"]
  });

  try {
    await run(browser);
  } finally {
    await browser.close();
  }
}

async function proxyFunction(request, response) {
  const body = await readRequestBody(request);
  const functionResponse = await roomHandler(new Request(`http://127.0.0.1${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : body
  }));

  response.writeHead(functionResponse.status, Object.fromEntries(functionResponse.headers.entries()));
  response.end(Buffer.from(await functionResponse.arrayBuffer()));
}

async function serveStatic(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const cleanPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = new URL(`.${cleanPath}`, PUBLIC_DIR);

  if (!filePath.href.startsWith(PUBLIC_DIR.href)) {
    response.writeHead(403);
    response.end();
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath.pathname) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function contentType(pathname) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  return types[extname(pathname)] || "application/octet-stream";
}

async function forceRoom(store, roomId, mutate) {
  const file = join(store, `${roomId}.json`);
  const room = JSON.parse(await readFile(file, "utf8"));
  await mutate(room);
  await writeFile(file, JSON.stringify(room, null, 2));
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

function clickLetter(page, letter) {
  return page.locator(`#keyboard button[data-letter="${letter}"]`).click();
}

async function isLetterDisabled(page, letter) {
  return page.locator(`#keyboard button[data-letter="${letter}"]`).isDisabled();
}

async function waitText(page, selector, pattern) {
  await page.waitForFunction(
    ({ selector, source, flags }) => new RegExp(source, flags).test(document.querySelector(selector)?.textContent || ""),
    { selector, source: pattern.source, flags: pattern.flags },
    { timeout: 8000 }
  );
}

async function text(page, selector) {
  return page.locator(selector).textContent().then((value) => value.trim());
}

async function inputValue(page, selector) {
  return page.locator(selector).inputValue();
}

async function aria(page, selector) {
  return page.locator(selector).getAttribute("aria-label");
}

async function statFor(page, playerName, label) {
  return page.evaluate(({ playerName, label }) => {
    const rows = [...document.querySelectorAll(".score-row")];
    const row = rows.find((item) => item.textContent.includes(playerName));
    if (!row) return null;
    const stat = [...row.querySelectorAll(".score-values span")]
      .find((item) => item.textContent.includes(label));
    return stat?.querySelector("b")?.textContent || null;
  }, { playerName, label });
}

async function assertNoHorizontalOverflow(page) {
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    keyboardButtons: document.querySelectorAll("#keyboard button").length
  }));
  assert.equal(sizes.keyboardButtons, 27);
  assert.ok(sizes.scrollWidth <= sizes.clientWidth, `horizontal overflow: ${sizes.scrollWidth} > ${sizes.clientWidth}`);
}

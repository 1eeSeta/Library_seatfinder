import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = await readFile(path.join(here, '.env'), 'utf8');
  for (const line of envText.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const name = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (process.env[name] === undefined) process.env[name] = value;
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const port = Number(process.env.PORT || 3000);
const apiBase = 'https://apis.data.go.kr/B551982/plr_v2/rlt_rdrm_info_v2';
const libraryInfoBase = 'https://apis.data.go.kr/B551982/plr_v2/info_v2';
const libraryInfoCache = new Map();
const libraryInfoInFlight = new Map();
const cacheTtlMs = 5 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}

function itemsFrom(body) {
  const value = body?.item ?? body?.items?.item ?? [];
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

async function loadApi(stdgCd, endpoint, cacheStore, pendingStore) {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) {
    const error = new Error('서버에 DATA_GO_KR_SERVICE_KEY 환경변수를 설정해야 합니다.');
    error.status = 503;
    throw error;
  }
  const now = Date.now();
  const cached = cacheStore.get(stdgCd);
  if (cached && now - cached.fetchedAt < cacheTtlMs) return cached.payload;
  if (pendingStore.has(stdgCd)) return pendingStore.get(stdgCd);

  const task = (async () => {
    const allItems = [];
    let totalCount = 0;
    let resultCode = 'K0';
    let resultMsg = 'NORMAL_SERVICE';
    for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ serviceKey: key, pageNo: String(pageNo), numOfRows: '100', type: 'JSON', stdgCd }).toString();
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('API가 JSON이 아닌 응답을 반환했습니다 (HTTP ' + response.status + '). 인증키와 API 경로를 확인해 주세요.'); }
      if (!response.ok) throw new Error('공공데이터 API 요청 실패 (HTTP ' + response.status + ').');
      const header = data.header ?? data.response?.header ?? {};
      const body = data.body ?? data.response?.body ?? {};
      resultCode = String(header.resultCode ?? '');
      resultMsg = header.resultMsg ?? '';
      if (resultCode !== 'K0' && resultCode !== '00') {
        if ((resultCode === 'K3' || resultMsg === 'NODATA_ERROR') && pageNo === 1) {
          const payload = { stdgCd, totalCount: 0, items: [], fetchedAt: new Date().toISOString(), resultCode, resultMsg: resultMsg || 'NODATA_ERROR' };
          cacheStore.set(stdgCd, { fetchedAt: Date.now(), payload });
          return payload;
        }
        if ((resultCode === 'K3' || resultMsg === 'NODATA_ERROR') && allItems.length) break;
        throw new Error('공공데이터 API 오류 ' + resultCode + ': ' + (resultMsg || '알 수 없는 오류'));
      }
      totalCount = Number(body.totalCount ?? totalCount);
      const pageItems = itemsFrom(body);
      allItems.push(...pageItems);
      if (allItems.length >= totalCount || pageItems.length === 0) break;
    }
    const payload = { stdgCd, totalCount, items: allItems, fetchedAt: new Date().toISOString(), resultCode, resultMsg: resultMsg || 'NORMAL_SERVICE' };
    cacheStore.set(stdgCd, { fetchedAt: Date.now(), payload });
    return payload;
  })();
  pendingStore.set(stdgCd, task);
  try { return await task; }
  finally { pendingStore.delete(stdgCd); }
}

async function loadSeats(stdgCd) { return loadApi(stdgCd, apiBase, cache, inFlight); }
async function loadLibraries(stdgCd) { return loadApi(stdgCd, libraryInfoBase, libraryInfoCache, libraryInfoInFlight); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && url.pathname === '/api/seats') {
    const rawCodes = url.searchParams.get('stdgCds');
    const codes = rawCodes ? [...new Set(rawCodes.split(',').map(code => code.trim()))] : [url.searchParams.get('stdgCd') || '1168000000'];
    if (codes.length > 5 || codes.some(code => !/^\d{10}$/.test(code))) return send(res, 400, { error: '자치구 코드는 최대 5개의 숫자 10자리여야 합니다.' });
    const settledSeats = await Promise.allSettled(codes.map(loadSeats));
    const settledLibraries = await Promise.allSettled(codes.map(loadLibraries));
    const failedSeats = settledSeats.find(result => result.status === 'rejected');
    if (settledSeats.every(result => result.status === 'rejected')) return send(res, failedSeats.reason.status || 502, { error: failedSeats.reason.message });
    const seats = settledSeats.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const libraries = settledLibraries.flatMap(result => result.status === 'fulfilled' ? result.value.items || [] : []);
    const districtResults = codes.map((stdgCd, index) => ({
      stdgCd,
      totalCount: settledSeats[index].status === 'fulfilled' ? settledSeats[index].value.totalCount : 0,
      resultCode: settledSeats[index].status === 'fulfilled' ? settledSeats[index].value.resultCode : 'ERROR',
      resultMsg: settledSeats[index].status === 'rejected' ? settledSeats[index].reason.message : settledSeats[index].value.resultMsg,
      infoResultCode: settledLibraries[index].status === 'fulfilled' ? settledLibraries[index].value.resultCode : 'ERROR',
      infoResultMsg: settledLibraries[index].status === 'rejected' ? settledLibraries[index].reason.message : settledLibraries[index].value.resultMsg,
    }));
    return send(res, 200, {
      stdgCds: codes,
      totalCount: seats.reduce((sum, data) => sum + Number(data.totalCount || 0), 0),
      items: seats.flatMap(data => data.items || []),
      libraries,
      fetchedAt: new Date().toISOString(),
      districts: districtResults,
    });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = await readFile(path.join(here, 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch { return send(res, 500, 'index.html을 읽을 수 없습니다.', 'text/plain; charset=utf-8'); }
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`빈자리 레이더 실행 중: http://${host}:${port}`);
  console.log('API key:', process.env.DATA_GO_KR_SERVICE_KEY ? '설정됨' : '미설정');
});




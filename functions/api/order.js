// ============ 全局常量 ============
const PHONE_TTL_MS = 65 * 1000;   // 手机号有效期：65 秒
const MAX_ATTEMPTS = 3;           // 最大复用次数

// ============ 订单号格式校验 ============
const OID_PATTERN = /^HZ[A-Z0-9]{6,20}$/i;
function isValidOid(value) {
  return typeof value === 'string' && OID_PATTERN.test(value);
}

// ============ 带超时的 fetch ============
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw new Error('接码平台请求超时或被中断');
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const action = url.searchParams.get('action');
  const oid = url.searchParams.get('oid');

  if (oid && !isValidOid(oid)) {
    return jsonResponse({ error: '订单ID格式不正确' }, 400);
  }

  try {
    const DB = env.DB;
    if (!DB) throw new Error('严重错误：D1 数据库 (DB) 未绑定');

    async function getConfig(key) {
      const row = await DB.prepare('SELECT value FROM kv_store WHERE key = ?').bind(key).first();
      return row ? JSON.parse(row.value) : null;
    }
    async function putConfig(key, obj) {
      await DB.prepare(
        'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, JSON.stringify(obj)).run();
    }
    async function deleteConfig(key) {
      await DB.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run();
    }

    const apiCfg = await getConfig('__api_config__') || {};
    const apiUser = apiCfg.user || '';
    const apiPass = apiCfg.pass || '';
    const sid = url.searchParams.get('sid') || apiCfg.sid || '24085';

    const poolActions = [
      'addPhone', 'removePhone', 'poolList', 'resetPool', 'releasePoolPhone', 'logList',
      'getBalance', 'lockOrder', 'blockPhone',
      'generateCard', 'activateCard', 'verifyCard', 'cardList', 'deleteCard',
      'createOrder', 'listActiveOrders', 'listAllOrders', 'releaseAllOrders',
      'cancelRecvPhone', 'saveApiConfig', 'getApiConfig', 'rebuildOrderIndex',
      'mockSMS'
    ];
    if (!oid && !poolActions.includes(action)) {
      return jsonResponse({ error: '缺少订单ID' }, 400);
    }

    const HAOZHU = { server: 'api.haozhuma.com', user: apiUser, pass: apiPass, sid };

    // ===== 订单读写 =====
    async function getOrder(oid) {
      const row = await DB.prepare('SELECT * FROM orders WHERE oid = ?').bind(oid).first();
      if (!row) return null;
      return {
        status: row.status,
        sid: row.sid,
        assignedPhone: row.assigned_phone,
        phone: row.phone,
        expire: row.expire,
        code: row.code,
        fromPool: !!row.from_pool,
        createdAt: row.created_at,
        doneTime: row.done_time,
        phoneAssignedAt: row.phone_assigned_at,
        filters: row.filters_json ? JSON.parse(row.filters_json) : {},
        attempts: row.attempts || 0
      };
    }

    async function saveOrder(oid, order) {
      await DB.prepare(`
        INSERT INTO orders (oid, status, sid, assigned_phone, phone, expire, code, from_pool,
                            created_at, done_time, phone_assigned_at, filters_json, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(oid) DO UPDATE SET
          status = excluded.status,
          sid = excluded.sid,
          assigned_phone = excluded.assigned_phone,
          phone = excluded.phone,
          expire = excluded.expire,
          code = excluded.code,
          from_pool = excluded.from_pool,
          done_time = excluded.done_time,
          phone_assigned_at = excluded.phone_assigned_at,
          filters_json = excluded.filters_json,
          attempts = excluded.attempts
      `).bind(
        oid,
        order.status || 'new',
        order.sid || null,
        order.assignedPhone || null,
        order.phone || null,
        order.expire || null,
        order.code || null,
        order.fromPool ? 1 : 0,
        order.createdAt || 0,
        order.doneTime || null,
        order.phoneAssignedAt || null,
        order.filters ? JSON.stringify(order.filters) : null,
        order.attempts || 0
      ).run();
    }

    // ===== 手机池 =====
    async function getPool() {
      const { results } = await DB.prepare('SELECT * FROM phone_pool').all();
      return results.map(r => ({
        phone: r.phone,
        status: r.status,
        oid: r.oid,
        expire: r.expire
      }));
    }

    async function updateActiveIndex(oid, phone, expire) {
      await DB.prepare(
        'INSERT INTO active_orders (oid, phone, expire) VALUES (?, ?, ?) ' +
        'ON CONFLICT(oid) DO UPDATE SET phone = excluded.phone, expire = excluded.expire'
      ).bind(oid, phone, expire).run();
    }
    async function removeFromActiveIndex(oid) {
      await DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(oid).run();
    }

    async function getValidToken() {
      if (!HAOZHU.user || !HAOZHU.pass) throw new Error('未配置接码平台账号密码');

      const tokenData = await getConfig('__token_data__');
      let tokenStr = tokenData ? tokenData.token : null;
      let tokenExpiry = tokenData ? tokenData.expire : 0;
      const tokenApiUser = tokenData ? tokenData.apiUser : null;
      const tokenApiPass = tokenData ? tokenData.apiPass : null;

      const needLogin = !tokenStr || Date.now() >= tokenExpiry - 300000
        || tokenApiUser !== HAOZHU.user || tokenApiPass !== HAOZHU.pass;

      if (needLogin) {
        const loginResp = await fetchWithTimeout(
          `https://${HAOZHU.server}/sms/?api=login&user=${HAOZHU.user}&pass=${HAOZHU.pass}`
        );
        const loginData = await loginResp.json();
        if (loginData.code == 0) {
          tokenStr = loginData.token || loginData.Token || loginData.access_token;
          tokenExpiry = Date.now() + 3500000;
          await putConfig('__token_data__', {
            token: tokenStr, expire: tokenExpiry, apiUser: HAOZHU.user, apiPass: HAOZHU.pass
          });
        } else {
          throw new Error('接码平台登录失败：' + (loginData.msg || ''));
        }
      }
      return tokenStr;
    }

    async function releaseOrderPhone(order, oid) {
      if (!order || !order.phone) return;
      if (order.fromPool) {
        await DB.prepare(
          "UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ? AND status = 'in_use'"
        ).bind(order.phone).run();
      } else {
        try {
          const tokenStr = await getValidToken();
          const orderSid = order.sid || HAOZHU.sid;
          await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        } catch (e) { console.error('释放号码失败:', e); }
      }
      if (oid) await removeFromActiveIndex(oid);
    }

    // ===== 业务分发 =====
    switch (action) {
      case 'getApiConfig': {
        const cfg = await getConfig('__api_config__') || {};
        return jsonResponse({
          success: true,
          apiUser: cfg.user || '',
          apiPass: cfg.pass || '',
          sid: cfg.sid || '24085',
          customNotice: cfg.customNotice || ''
        });
      }

      case 'mockSMS': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status !== 'active' && order.status !== 'expired') return jsonResponse({ error: '订单未处于等待接码状态' }, 400);

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        let newAttempts = order.attempts || 0;
        newAttempts += 1; 

        if (newAttempts >= MAX_ATTEMPTS) {
          await DB.batch([
            DB.prepare("UPDATE orders SET code = ?, status = 'done', done_time = ?, attempts = ?, expire = NULL WHERE oid = ?")
              .bind(code, Date.now(), newAttempts, oid),
            DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(oid)
          ]);
        } else {
          await DB.prepare("UPDATE orders SET code = ?, status = 'active', attempts = ?, expire = NULL WHERE oid = ?")
            .bind(code, newAttempts, oid).run();
        }
        
        if (order.phone) {
          await DB.prepare('INSERT INTO phone_logs (phone, oid, action, time) VALUES (?, ?, ?, ?)')
            .bind(order.phone, oid, 'sms_received', new Date().toISOString()).run();
        }

        return jsonResponse({ success: true, code, attempts: newAttempts, status: newAttempts >= MAX_ATTEMPTS ? 'done' : 'active' });
      }

      case 'status': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        
        if (order.expire && order.status === 'active' && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          // 不重置 phone，保留旧号码供用户选择复用
          await DB.prepare(
            "UPDATE orders SET status = 'expired', expire = NULL WHERE oid = ?"
          ).bind(oid).run();
          return jsonResponse({ status: 'expired', phone: order.phone, expire: null, code: null, attempts: order.attempts });
        }
        return jsonResponse(order);
      }

      case 'reuse': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.attempts >= MAX_ATTEMPTS) return jsonResponse({ error: '最大使用次数已达上限', status: 'done' }, 403);

        const reusePhone = order.phone;
        if (!reusePhone) return jsonResponse({ error: '当前没有可复用的号码' }, 400);

        try {
          const tokenStr = await getValidToken();
          const orderSid = order.sid || HAOZHU.sid;
          const reqUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${encodeURIComponent(reusePhone)}`;
          const phoneResp = await fetchWithTimeout(reqUrl);
          const phoneData = await phoneResp.json();

          if (phoneData.code == 0) {
            order.expire = Date.now() + PHONE_TTL_MS;
            order.status = 'active';
            order.code = null; // 清空旧验证码
            await saveOrder(oid, order);
            await updateActiveIndex(oid, reusePhone, order.expire);
            return jsonResponse({ success: true, phone: reusePhone, expire: order.expire, attempts: order.attempts });
          }
          return jsonResponse({ error: '复用号码失败: ' + (phoneData.msg || '该号码已被释放，请获取新号') }, 400);
        } catch (e) {
          return jsonResponse({ error: '请求接码平台超时或出错: ' + e.message }, 500);
        }
      }

      case 'getPhone': {
        let order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在或已失效' }, 404);
        
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);

        if (order.status === 'expired') {
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await saveOrder(oid, order);
        }

        if (order.status === 'active' && order.expire && Date.now() < order.expire) {
          return jsonResponse({ phone: order.phone, expire: order.expire, attempts: order.attempts });
        }

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await saveOrder(oid, order);
        }

        if (order.phone && order.fromPool) {
          await DB.prepare(
            "UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ? AND status = 'in_use'"
          ).bind(order.phone).run();
        }

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;

        if (order.assignedPhone) {
          const reqUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${encodeURIComponent(order.assignedPhone)}`;
          const phoneResp = await fetchWithTimeout(reqUrl);
          const phoneData = await phoneResp.json();
          if (phoneData.code == 0) {
            const realPhone = phoneData.phone || phoneData.Phone || phoneData.mobile || order.assignedPhone;
            order.phone = realPhone;
            order.expire = Date.now() + PHONE_TTL_MS;
            order.status = 'active';
            order.code = null;
            order.fromPool = false;
            order.phoneAssignedAt = Date.now();
            await saveOrder(oid, order);
            await updateActiveIndex(oid, realPhone, order.expire);
            return jsonResponse({ phone: realPhone, expire: order.expire, attempts: order.attempts });
          }
          return jsonResponse({ error: '获取指定手机号失败：' + (phoneData.msg || '平台无该号或已被占用') }, 400);
        }

        // 池中取号
        const expire = Date.now() + PHONE_TTL_MS;
        const pickedRes = await DB.prepare(`
          UPDATE phone_pool SET status = 'in_use', oid = ?, expire = ?
          WHERE phone = (SELECT phone FROM phone_pool WHERE status = 'available' ORDER BY RANDOM() LIMIT 1)
          RETURNING phone
        `).bind(oid, expire).all();

        const picked = pickedRes.results && pickedRes.results[0];
        if (picked) {
          const phone = picked.phone;
          try {
            const activateUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${phone}`;
            await fetchWithTimeout(activateUrl);
          } catch (e) {}

          order.phone = phone;
          order.expire = expire;
          order.status = 'active';
          order.code = null;
          order.fromPool = true;
          order.phoneAssignedAt = Date.now();
          await saveOrder(oid, order);
          await updateActiveIndex(oid, phone, expire);
          return jsonResponse({ phone, expire, attempts: order.attempts });
        }

        // 平台取号
        const f = order.filters || {};
        let apiUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}`;
        if (f.ascription) apiUrl += `&ascription=${encodeURIComponent(f.ascription)}`;
        if (f.paragraph)  apiUrl += `&paragraph=${encodeURIComponent(f.paragraph)}`;
        if (f.exclude)    apiUrl += `&exclude=${encodeURIComponent(f.exclude)}`;
        if (f.isp)        apiUrl += `&isp=${encodeURIComponent(f.isp)}`;
        if (f.province)   apiUrl += `&Province=${encodeURIComponent(f.province)}`;
        if (f.uid)        apiUrl += `&uid=${encodeURIComponent(f.uid)}`;

        const phoneResp = await fetchWithTimeout(apiUrl);
        const phoneData = await phoneResp.json();
        if (phoneData.code == 0) {
          const phone = phoneData.phone || phoneData.Phone || phoneData.mobile;
          order.phone = phone;
          order.expire = Date.now() + PHONE_TTL_MS;
          order.status = 'active';
          order.code = null;
          order.fromPool = false;
          order.phoneAssignedAt = Date.now();
          await saveOrder(oid, order);
          await updateActiveIndex(oid, phone, order.expire);
          return jsonResponse({ phone, expire: order.expire, attempts: order.attempts });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      case 'release': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        await releaseOrderPhone(order, oid);

        await DB.prepare(
          "UPDATE orders SET status = 'new', phone = NULL, expire = NULL, code = NULL, from_pool = 0 WHERE oid = ?"
        ).bind(oid).run();
        return jsonResponse({ success: true });
      }

      case 'getSMS': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          await DB.prepare(
            "UPDATE orders SET status = 'expired', expire = NULL WHERE oid = ?"
          ).bind(oid).run();
          return jsonResponse({ status: 'expired', code: null, phone: order.phone });
        }

        if (!order.phone) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status !== 'active') return jsonResponse({ status: order.status, code: order.code || null, attempts: order.attempts });

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;
        const smsResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getMessage&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        const smsData = await smsResp.json();

        if (smsData.code == 0) {
          const raw = smsData.sms || smsData.Sms || smsData.message || smsData.code_text || '';
          if (raw) {
            const match = raw.match(/(?<!\d)(\d{4,6})(?!\d)/);
            if (match) {
              const code = match[1];
              let newAttempts = order.attempts || 0;
              
              if (order.code !== code) {
                newAttempts += 1;
              }

              if (newAttempts >= MAX_ATTEMPTS) {
                await DB.batch([
                  DB.prepare("UPDATE orders SET code = ?, status = 'done', done_time = ?, attempts = ?, expire = NULL WHERE oid = ?")
                    .bind(code, Date.now(), newAttempts, oid),
                  DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(oid)
                ]);
              } else {
                await DB.prepare("UPDATE orders SET code = ?, attempts = ?, expire = NULL WHERE oid = ?").bind(code, newAttempts, oid).run();
              }
              await DB.prepare('INSERT INTO phone_logs (phone, oid, action, time) VALUES (?, ?, ?, ?)')
                .bind(order.phone, oid, 'sms_received', new Date().toISOString()).run();
              return jsonResponse({ code, status: newAttempts >= MAX_ATTEMPTS ? 'done' : 'active', attempts: newAttempts });
            }
          }
        }
        return jsonResponse({ code: null, status: 'active', attempts: order.attempts });
      }

      default:
        return jsonResponse({ error: '未知操作' }, 400);
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Worker 内部异常: ' + e.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}

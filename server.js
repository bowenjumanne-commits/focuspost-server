const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


cloudinary.config({
  cloud_name: 'dmuxzxeiu',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_id TEXT,
        username TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at BIGINT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (device_id, platform)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id SERIAL PRIMARY KEY,
        device_id TEXT NOT NULL,
        fire_at BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT DEFAULT 0,
        post_target TEXT,
        post_mode TEXT,
        caption TEXT,
        caption_tiktok TEXT,
        media_urls TEXT,
        media_types TEXT,
        public_ids TEXT,
        tt_options TEXT,
        fail_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query('ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS acked BOOLEAN DEFAULT FALSE;');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        push_token TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS device_auth (
        device_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('DB READY');
  } catch (e) {
    console.error('DB init failed:', e.message);
  }
})();


 const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-device-secret'] || req.ip,
  message: { error: 'You have used a lot of AI suggestions. Try again in a bit.' },
});

// --- DEVICE AUTH ---
async function deviceAuth(req, res, next) {
  const deviceId = (req.body && req.body.deviceId) || (req.query && req.query.deviceId);
  const secret = req.headers['x-device-secret'];
  if (!deviceId) return res.status(400).json({ error: 'missing deviceId' });
  if (!secret || String(secret).length < 20) {
    console.log('DEVICE AUTH: no secret sent for', deviceId);
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const r = await pool.query('SELECT secret FROM device_auth WHERE device_id = $1', [deviceId]);
    if (r.rows.length === 0) {
      await pool.query(
        'INSERT INTO device_auth (device_id, secret) VALUES ($1, $2) ON CONFLICT (device_id) DO NOTHING',
        [deviceId, secret]
      );
      console.log('DEVICE AUTH: registered new device', deviceId);
      return next();
    }
    if (r.rows[0].secret !== secret) {
      console.log('DEVICE AUTH: REJECTED', deviceId);
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  } catch (e) {
    console.error('deviceAuth error:', e.message);
    return res.status(500).json({ error: 'auth check failed' });
  }
}
// --- END DEVICE AUTH ---


// ─── INSTAGRAM ───────────────────────────────────────────
app.post('/post/instagram', async (req, res) => {
  try {
    const { caption, imageUrl, imageUrls, mediaItems, accessToken, userId, mute } = req.body;

    let items = [];
    if (mediaItems && mediaItems.length > 0) {
      items = mediaItems;
    } else if (imageUrls && imageUrls.length > 0) {
      items = imageUrls.map(u => ({ url: u, type: 'image' }));
    } else {
      items = [{ url: imageUrl, type: 'image' }];
    }

    console.log('Instagram post, item count:', items.length, items.map(i => i.type));
    console.log('IG URLS:', JSON.stringify(req.body.imageUrls || req.body.mediaItems || []));
    console.log('IG URLS:', JSON.stringify(req.body.imageUrls || req.body.mediaItems || []));

    // ─── SINGLE ITEM ───
    if (items.length === 1) {
      const item = items[0];
      const isVideo = item.type === 'video';
      const uploadOptions = { resource_type: isVideo ? 'video' : 'image' };
      if (isVideo && mute) {
        uploadOptions.transformation = [{ audio_codec: 'none' }];
      }
       const skipReupload = typeof item.url === 'string' && item.url.includes('res.cloudinary.com') && !(isVideo && mute);
      let publicUrl = skipReupload ? item.url : (await cloudinary.uploader.upload(item.url, uploadOptions)).secure_url;
      if (!isVideo && publicUrl.includes('/image/upload/') && !publicUrl.includes('f_jpg')) {
        publicUrl = publicUrl.replace('/image/upload/', '/image/upload/c_limit,w_1440,f_jpg/');
      }
      console.log('IG SOURCE URL:', publicUrl, '| reuploaded:', !skipReupload);

      const containerPayload = isVideo
        ? { media_type: 'REELS', video_url: publicUrl, caption: caption, access_token: accessToken }
        : { image_url: publicUrl, caption: caption, access_token: accessToken };

      console.log('IG CONTAINER CREATE start');
      let containerRes;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          containerRes = await axios.post(
            `https://graph.instagram.com/v18.0/${userId}/media`,
            containerPayload,
            { timeout: 120000 }
          );
          break;
        } catch (err) {
          const sub = err.response?.data?.error?.error_subcode;
          if (attempt < 3 && sub === 2207052) {
            console.log('IG CONTAINER: media fetch failed, retry', attempt);
            await new Promise(r => setTimeout(r, 4000));
            continue;
          }
          throw err;
        }
      }
      console.log('IG CONTAINER CREATE done:', containerRes.data.id);
      const containerId = containerRes.data.id;

      if (isVideo) {
        await waitForFinished(containerId, accessToken);
      } else {
        await new Promise(r => setTimeout(r, 5000));
      }

      const publishRes = await publishWithRetry(userId, containerId, accessToken);
      return res.json({ success: true, postId: publishRes.data.id });
    }

    // ─── CAROUSEL (multiple items, photo/video/mixed) ───
    const childResults = await Promise.all(
      items.map(async (item) => {
       const isVideo = item.type === 'video';
        const childUploadOptions = { resource_type: isVideo ? 'video' : 'image' };
        if (isVideo && mute) {
          childUploadOptions.transformation = [{ audio_codec: 'none' }];
        }
        const upload = await cloudinary.uploader.upload(item.url, childUploadOptions);

        const childPayload = isVideo
          ? { media_type: 'VIDEO', video_url: upload.secure_url, is_carousel_item: true, access_token: accessToken }
          : { image_url: upload.secure_url, is_carousel_item: true, access_token: accessToken };

        const childRes = await axios.post(
          `https://graph.instagram.com/v18.0/${userId}/media`,
          childPayload
        );
        return { id: childRes.data.id, isVideo };
      })
    );




    await Promise.all(
      childResults
        .filter(c => c.isVideo)
        .map(c => waitForFinished(c.id, accessToken))
    );

    const childIds = childResults.map(c => c.id);
    await new Promise(r => setTimeout(r, 3000));

    const parentRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media`,
      { media_type: 'CAROUSEL', children: childIds.join(','), caption: caption, access_token: accessToken }
    );
    const parentId = parentRes.data.id;

    // Wait for the PARENT carousel container itself to finish before publishing
    await waitForFinished(parentId, accessToken);

    const publishRes = await publishWithRetry(userId, parentId, accessToken);
    res.json({ success: true, postId: publishRes.data.id });

  } catch (error) {
    console.error('Instagram error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── INSTAGRAM STORY (photo or video) ────────────────────
app.post('/post/instagram-story', async (req, res) => {
  try {
    const { imageUrl, mediaItems, accessToken, userId, mute} = req.body;

    // Determine the media and its type
    let mediaUrl = imageUrl;
    let isVideo = false;
    if (mediaItems && mediaItems.length > 0) {
      mediaUrl = mediaItems[0].url;
      isVideo = mediaItems[0].type === 'video';
    }

    console.log('Instagram story post, isVideo:', isVideo, 'url:', mediaUrl);

    // Upload to Cloudinary
    const uploadOptions = { resource_type: isVideo ? 'video' : 'image' };
    if (isVideo && mute) {
      uploadOptions.transformation = [{ audio_codec: 'none' }];
    }
    const upload = await cloudinary.uploader.upload(mediaUrl, uploadOptions);
    const publicUrl = upload.secure_url;

    // Create story container
    const containerPayload = isVideo
      ? { media_type: 'STORIES', video_url: publicUrl, access_token: accessToken }
      : { media_type: 'STORIES', image_url: publicUrl, access_token: accessToken };

    const containerRes = await axios.post(
      `https://graph.instagram.com/v18.0/${userId}/media`,
      containerPayload
    );
    const containerId = containerRes.data.id;

    // Videos need processing time, photos just need a brief wait
    if (isVideo) {
      await waitForFinished(containerId, accessToken);
    } else {
      await new Promise(r => setTimeout(r, 5000));
    }

    // Publish
    const publishRes = await publishWithRetry(userId, containerId, accessToken);
    res.json({ success: true, postId: publishRes.data.id });

  } catch (error) {
    console.error('Instagram story error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── GET USER'S MEDIA (list posts) ───────────────────────
app.get('/instagram/media', async (req, res) => {
  try {
    const { userId, accessToken } = req.query;
    const response = await axios.get(
      `https://graph.instagram.com/v18.0/${userId}/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,comments_count&access_token=${accessToken}`
    );
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('Get media error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── GET COMMENTS ON A POST ──────────────────────────────
app.get('/instagram/comments', async (req, res) => {
  try {
const { mediaId, accessToken } = req.query;
  const response = await axios.get(
      `https://graph.instagram.com/v18.0/${mediaId}/comments?fields=id,text,username,timestamp&access_token=${accessToken}`
    );
    console.log('IG COMMENTS for', mediaId, '->', JSON.stringify(response.data));
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('Get comments error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── REPLY TO A COMMENT ──────────────────────────────────
app.post('/instagram/reply', async (req, res) => {
  try {
    const { commentId, message, accessToken } = req.body;
    const response = await axios.post(
      `https://graph.instagram.com/v18.0/${commentId}/replies`,
      { message: message, access_token: accessToken }
    );
    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error('Reply error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

async function waitForFinished(containerId, accessToken) {
  let status = 'IN_PROGRESS';
  let attempts = 0;
  const maxAttempts = 40;
  while (status === 'IN_PROGRESS' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await axios.get(
      `https://graph.instagram.com/v18.0/${containerId}?fields=status_code,status&access_token=${accessToken}`
    );
    status = statusRes.data.status_code;
    console.log('Container', containerId, 'status:', status, 'detail:', statusRes.data.status, 'attempt', attempts);
    attempts++;
  }
  if (status === 'ERROR') {
    throw new Error('Video processing failed. The video format may be unsupported.');
  }
  if (status !== 'FINISHED') {
    throw new Error('Video is taking longer than expected. Please try again in a moment.');
  }
}

async function publishWithRetry(userId, creationId, accessToken, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media_publish`,
        { creation_id: creationId, access_token: accessToken }
      );
    } catch (err) {
      const subcode = err.response?.data?.error?.error_subcode;
      console.log('Publish attempt', attempt, 'failed. Subcode:', subcode);
      if (subcode === 2207027 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}
app.get('/tiktokvMd2oO9eOR94eQo4zO5jgWDzwLz8mgaJ.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=vMd2oO9eOR94eQo4zO5jgWDzwLz8mgaJ');
});
app.get('/tiktok4deWatyxf2MWmO55hGL43GhF67B4HE1B.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=4deWatyxf2MWmO55hGL43GhF67B4HE1B');
});
app.get('/tiktokof2oWWlRe4xtaZeQEykAVtttnJU8z1kx.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=of2oWWlRe4xtaZeQEykAVtttnJU8z1kx');
});
app.get('/tiktokb92ctT2N4SRTvou3958hhbLanOy7HfR7.txt', (req, res) => {
  res.type('text/plain').send('tiktok-developers-site-verification=b92ctT2N4SRTvou3958hhbLanOy7HfR7');
});

app.post('/tiktok/status', async (req, res) => {
  try {
    const { accessToken, publishId } = req.body;
    const response = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      { publish_id: publishId },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
    );
    console.log('TIKTOK STATUS:', JSON.stringify(response.data));
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('TikTok status error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.post('/schedule/create', deviceAuth, async (req, res) => {
  try {
    const { deviceId, fireAt, postTarget, postMode, caption, captionTiktok, mediaUrls, mediaTypes, publicIds, ttOptions } = req.body;
    if (!deviceId || !fireAt) return res.status(400).json({ success: false, error: 'missing deviceId or fireAt' });
    const maxAhead = Date.now() + 30 * 24 * 60 * 60 * 1000;
    if (fireAt > maxAhead) return res.status(400).json({ success: false, error: 'Can only schedule up to 30 days ahead' });
    if (fireAt < Date.now() + 60000) return res.status(400).json({ success: false, error: 'Pick a time at least a minute from now' });
    const r = await pool.query(
      `INSERT INTO scheduled_posts (device_id, fire_at, post_target, post_mode, caption, caption_tiktok, media_urls, media_types, public_ids, tt_options)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [deviceId, fireAt, postTarget || 'instagram', postMode || 'post', caption || '', captionTiktok || '',
       JSON.stringify(mediaUrls || []), JSON.stringify(mediaTypes || []), JSON.stringify(publicIds || []), JSON.stringify(ttOptions || {})]
    );
    console.log('SCHEDULED:', r.rows[0].id, 'for', new Date(Number(fireAt)).toISOString());
    res.json({ success: true, id: r.rows[0].id });
  } catch (e) {
    console.error('schedule create error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/schedule/list', deviceAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: 'missing deviceId' });
    const r = await pool.query(
      `SELECT id, fire_at, status, attempts, post_target, post_mode, caption, caption_tiktok, media_urls, media_types, fail_reason
       FROM scheduled_posts WHERE device_id=$1 AND status != 'done' ORDER BY fire_at ASC`,
      [deviceId]
    );
    res.json({ success: true, posts: r.rows });
  } catch (e) {
    console.error('schedule list error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/schedule/completed', deviceAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ success: false, error: 'missing deviceId' });
    const r = await pool.query(
      "SELECT id, fire_at, post_target, post_mode, caption, caption_tiktok, media_urls, media_types, tt_options FROM scheduled_posts WHERE device_id=$1 AND status='done' AND acked=FALSE",
      [deviceId]
    );
    if (r.rows.length > 0) {
      await pool.query("UPDATE scheduled_posts SET acked=TRUE WHERE device_id=$1 AND status='done' AND acked=FALSE", [deviceId]);
    }
    res.json({ success: true, posts: r.rows });
  } catch (e) {
    console.error('schedule completed error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/schedule/cancel', deviceAuth, async (req, res) => {
  try {
    const { deviceId, id } = req.body;
    const r = await pool.query('SELECT public_ids FROM scheduled_posts WHERE id=$1 AND device_id=$2', [id, deviceId]);
    await pool.query('DELETE FROM scheduled_posts WHERE id=$1 AND device_id=$2', [id, deviceId]);
    if (r.rows[0] && r.rows[0].public_ids) {
      const ids = JSON.parse(r.rows[0].public_ids);
      if (ids.length > 0) {
        cloudinary.api.delete_resources(ids).catch(() => {});
      }
    }
    console.log('SCHEDULE CANCELLED:', id);
    res.json({ success: true });
  } catch (e) {
    console.error('schedule cancel error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/schedule/reschedule', deviceAuth, async (req, res) => {
  try {
    const { deviceId, id, fireAt } = req.body;
    const maxAhead = Date.now() + 30 * 24 * 60 * 60 * 1000;
    if (fireAt > maxAhead) return res.status(400).json({ success: false, error: 'Can only schedule up to 30 days ahead' });
    if (fireAt < Date.now() + 60000) return res.status(400).json({ success: false, error: 'Pick a time at least a minute from now' });
    await pool.query("UPDATE scheduled_posts SET fire_at=$1, status='pending', attempts=0, fail_reason=NULL WHERE id=$2 AND device_id=$3", [fireAt, id, deviceId]);
    res.json({ success: true });
  } catch (e) {
    console.error('reschedule error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/device/push', deviceAuth, async (req, res) => {
  try {
    const { deviceId, pushToken } = req.body;
    if (!deviceId || !pushToken) return res.status(400).json({ success: false, error: 'missing fields' });
    await pool.query(
      `INSERT INTO devices (device_id, push_token, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (device_id) DO UPDATE SET push_token=$2, updated_at=NOW()`,
      [deviceId, pushToken]
    );
    console.log('PUSH TOKEN SAVED:', deviceId);
    res.json({ success: true });
  } catch (e) {
    console.error('push token save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

async function sendPush(deviceId, title, body) {
  try {
    const r = await pool.query('SELECT push_token FROM devices WHERE device_id=$1', [deviceId]);
    const token = r.rows[0] && r.rows[0].push_token;
    if (!token) return;
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: token,
      sound: 'default',
      title,
      body,
    }, { headers: { 'Content-Type': 'application/json' } });
    console.log('PUSH SENT:', deviceId, title);
  } catch (e) {
    console.error('push send failed:', e.response?.data || e.message);
  }
}

app.get('/tiktok/stats', deviceAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    const acct = await pool.query("SELECT * FROM accounts WHERE device_id=$1 AND platform='tiktok'", [deviceId]);
    if (!acct.rows[0]) return res.status(400).json({ success: false, error: 'TikTok not connected' });
    const token = await refreshTiktokIfNeeded(acct.rows[0]);
    const r = await axios.get(
      'https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,following_count,likes_count,video_count',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    console.log('TT STATS:', JSON.stringify(r.data));
    res.json({ success: true, stats: r.data?.data?.user || {} });
  } catch (e) {
    console.error('tt stats error:', e.response?.data || e.message);
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

app.get('/tiktok/videos', deviceAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    const acct = await pool.query("SELECT * FROM accounts WHERE device_id=$1 AND platform='tiktok'", [deviceId]);
    if (!acct.rows[0]) return res.status(400).json({ success: false, error: 'TikTok not connected' });
    const token = await refreshTiktokIfNeeded(acct.rows[0]);
    const r = await axios.post(
      'https://open.tiktokapis.com/v2/video/list/?fields=id,title,cover_image_url,create_time,view_count,like_count,comment_count,share_count',
      { max_count: 20 },
      { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
    );
    console.log('TT VIDEOS:', JSON.stringify(r.data).slice(0, 300));
    res.json({ success: true, videos: r.data?.data?.videos || [] });
  } catch (e) {
    console.error('tt videos error:', e.response?.data || e.message);
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

app.get('/instagram/insights', deviceAuth, async (req, res) => {
  try {
   const { deviceId } = req.query;
    const acct = await pool.query("SELECT access_token, account_id FROM accounts WHERE device_id=$1 AND platform='instagram'", [deviceId]);
    if (!acct.rows[0]) return res.status(400).json({ success: false, error: 'Instagram not connected for this device' });
   const accessToken = acct.rows[0].access_token;
    const userId = acct.rows[0].account_id;
    console.log('INSIGHTS TOKEN len:', accessToken ? accessToken.length : 0, 'starts:', accessToken ? accessToken.slice(0, 8) : 'none', 'userId:', userId);
    const media = await axios.get(
      `https://graph.instagram.com/v21.0/${userId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=10&access_token=${accessToken}`
    );
    const items = media.data.data || [];
    const out = [];
    for (const m of items) {
      let insights = null;
      try {
        const ins = await axios.get(
          `https://graph.instagram.com/v21.0/${m.id}/insights?metric=reach,shares,saved&access_token=${accessToken}`
        );
        insights = ins.data.data;
      } catch (e) {
        insights = { error: e.response?.data?.error?.message || e.message };
      }
      out.push({ ...m, insights });
    }
    console.log('IG INSIGHTS SAMPLE:', JSON.stringify(out[0]));
    res.json({ success: true, items: out });
  } catch (e) {
    console.error('ig insights error:', e.response?.data || e.message);
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

app.post('/account/save', deviceAuth, async (req, res) => {
  try {
    const { deviceId, platform, accountId, username, accessToken, refreshToken, expiresAt } = req.body;
    if (!deviceId || !platform) return res.status(400).json({ success: false, error: 'missing deviceId or platform' });
    await pool.query(
      `INSERT INTO accounts (device_id, platform, account_id, username, access_token, refresh_token, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (device_id, platform)
       DO UPDATE SET account_id=$3, username=$4, access_token=$5, refresh_token=$6, expires_at=$7, updated_at=NOW()`,
      [deviceId, platform, accountId || null, username || null, accessToken || null, refreshToken || null, expiresAt || null]
    );
    console.log('ACCOUNT SAVED:', deviceId, platform, 'len:', accessToken ? String(accessToken).length : 0, 'starts:', accessToken ? String(accessToken).slice(0, 8) : 'none');
    res.json({ success: true });
  } catch (e) {
    console.error('account save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/account/delete', deviceAuth, async (req, res) => {
  try {
    const { deviceId, platform } = req.body;
    await pool.query('DELETE FROM accounts WHERE device_id=$1 AND platform=$2', [deviceId, platform]);
    console.log('ACCOUNT DELETED:', deviceId, platform);
    res.json({ success: true });
  } catch (e) {
    console.error('account delete error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── TIKTOK ───────────────────────────────────────────────
app.post('/tiktok/creator-info', async (req, res) => {
  try {
    const { accessToken } = req.body;
    const response = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/creator_info/query/',
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );
    res.json({ success: true, data: response.data.data });
  } catch (error) {
    console.error('TikTok creator_info error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.post('/media/delete', async (req, res) => {
  try {
    const { publicIds, resourceType } = req.body;
    if (!Array.isArray(publicIds) || publicIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No publicIds provided' });
    }
    const result = await cloudinary.api.delete_resources(publicIds, {
      resource_type: resourceType || 'image',
    });
    console.log('CLOUDINARY DELETE:', JSON.stringify(result));
    res.json({ success: true, result });
  } catch (error) {
    console.error('Cloudinary delete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/media/p/:id', async (req, res) => {
  try {
    const raw = String(req.params.id || '');
    const id = raw.replace(/\.[a-z0-9]+$/i, '');
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) return res.status(400).send('Invalid id');
    const url = 'https://res.cloudinary.com/dmuxzxeiu/image/upload/c_limit,w_1080,h_1920,f_jpg/' + id + '.jpg';
    console.log('MEDIA P HIT:', url);
    const upstream = await axios.get(url, { responseType: 'stream', timeout: 20000 });
    res.set('Content-Type', 'image/jpeg');


    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    res.set('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch (e) {
    console.error('Media p error:', e.message);
    res.status(502).send('Upstream fetch failed');
  }
});


app.post('/post/tiktok-photo', async (req, res) => {
  try {
    const {
      accessToken, photoUrls, caption, title,
      privacyLevel, disableComment,
      
      brandOrganic, brandedContent, aiGenerated, autoAddMusic,
    } = req.body;

    if (!Array.isArray(photoUrls) || photoUrls.length === 0) {
      return res.status(400).json({ success: false, error: 'No photoUrls provided' });
    }

    const initRes = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/content/init/',
      {
        post_info: {
          title: title || caption || '',
          description: caption || '',
          privacy_level: privacyLevel || 'SELF_ONLY',
          disable_comment: !!disableComment,
          auto_add_music: autoAddMusic !== false,
          brand_organic_toggle: !!brandOrganic,
          brand_content_toggle: !!brandedContent,
          is_aigc: !!aiGenerated,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          photo_cover_index: 0,
          photo_images: photoUrls,
        },
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
    );
    console.log('TIKTOK PHOTO MUSIC FLAG:', autoAddMusic, '->', autoAddMusic !== false);
    console.log('TIKTOK PHOTO URLS:', JSON.stringify(photoUrls));
    console.log('TIKTOK PHOTO INIT:', JSON.stringify(initRes.data));
    const publishId = initRes.data?.data?.publish_id;
    if (!publishId) {
      return res.status(500).json({ success: false, error: initRes.data });
    }
    res.json({ success: true, publishId });
  } catch (error) {
    console.error('TikTok photo error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.post('/post/tiktok', async (req, res) => {
  try {
    const {
      accessToken, videoUrl, caption,
      privacyLevel, disableComment, disableDuet, disableStitch,
      brandOrganic, brandedContent, aiGenerated,
    } = req.body;

    const fileRes = await axios.get(videoUrl, { responseType: 'arraybuffer', maxContentLength: Infinity, maxBodyLength: Infinity });
    const buffer = Buffer.from(fileRes.data);
    const videoSize = buffer.length;
    console.log('TIKTOK video bytes:', videoSize);

    const initRes = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption || '',
          privacy_level: privacyLevel || 'SELF_ONLY',
          disable_comment: !!disableComment,
          disable_duet: !!disableDuet,
          disable_stitch: !!disableStitch,
          brand_organic_toggle: !!brandOrganic,
          brand_content_toggle: !!brandedContent,
          is_aigc: !!aiGenerated,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
    );

    const publishId = initRes.data?.data?.publish_id;
    const uploadUrl = initRes.data?.data?.upload_url;
    console.log('TIKTOK init:', JSON.stringify(initRes.data));

    if (!uploadUrl) {
      return res.status(500).json({ success: false, error: initRes.data });
    }

    await axios.put(uploadUrl, buffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoSize,
        'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    res.json({ success: true, publishId });
  } catch (error) {
    console.error('TikTok error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── X (TWITTER) - Ready when credits added ───────────────
app.post('/post/twitter', async (req, res) => {
  res.json({ success: false, message: 'X API credits not yet activated' });
});



// ─── THREADS ──────────────────────────────────────────────
app.post('/post/threads', async (req, res) => {
  try {
    const { caption, imageUrl, accessToken, userId } = req.body;

    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.threads.net/v1.0/${userId}/threads`,
      {
        media_type: imageUrl ? 'IMAGE' : 'TEXT',
        image_url: imageUrl || undefined,
        text: caption,
        access_token: accessToken,
      }
    );

    const containerId = containerRes.data.id;

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Publish
    const publishRes = await axios.post(
      `https://graph.threads.net/v1.0/${userId}/threads_publish`,
      {
        creation_id: containerId,
        access_token: accessToken,
      }
    );

    res.json({ success: true, postId: publishRes.data.id });
  } catch (error) {
    console.error('Threads error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});



app.get('/auth/instagram/login', (req, res) => {
  console.log('Instagram login route hit');

  
    const authUrl = `https://www.instagram.com/oauth/authorize?client_id=28235394152788591&redirect_uri=https://api.purpost.app/auth/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_insights&response_type=code`;
  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
                client_id: '28235394152788591',
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
                redirect_uri: 'https://api.purpost.app/auth/instagram/callback',
        code: code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
    let igToken = access_token;
    try {
      const longRes = await axios.get('https://graph.instagram.com/access_token', {
        params: {
          grant_type: 'ig_exchange_token',
          client_secret: process.env.INSTAGRAM_APP_SECRET,
          access_token: access_token,
        },
      });
      if (longRes.data && longRes.data.access_token) {
        igToken = longRes.data.access_token;
        console.log('IG LONG TOKEN, expires_in:', longRes.data.expires_in);
      }
    } catch (e) {
      console.error('IG long-lived exchange failed:', e.response?.data || e.message);
    }
        const userRes = await axios.get(
          `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${igToken}`
        );
        const username = userRes.data.username;
        const userId = userRes.data.id;
        res.redirect(`outpost://auth?token=${igToken}&userId=${userId}&username=${username}`);
          } catch (error) {
            console.error('Instagram callback error:', error.response?.data || error.message);
            res.redirect('outpost://auth?error=login_failed');
          }
        });

   app.post('/auth/tiktok/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log('TIKTOK REFRESH RESPONSE:', JSON.stringify(tokenRes.data));
    const { access_token, open_id, refresh_token, expires_in } = tokenRes.data;
    if (!access_token) {
      return res.status(400).json({ success: false, error: tokenRes.data });
    }
    res.json({ success: true, accessToken: access_token, userId: open_id, refreshToken: refresh_token, expiresIn: expires_in });
  } catch (error) {
    console.error('TikTok refresh error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// ─── TIKTOK AUTH ──────────────────────────────────────────
app.get('/auth/tiktok/login', (req, res) => {
const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish,video.list,user.info.stats,user.info.profile&response_type=code&redirect_uri=https://api.purpost.app/auth/tiktok/callback&state=outpost`;
  res.redirect(authUrl);
});

app.get('/auth/tiktok/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: 'https://api.purpost.app/auth/tiktok/callback',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
   console.log('TIKTOK TOKEN RESPONSE ok?', !!tokenRes.data.access_token, '| open_id:', tokenRes.data.open_id, '| expires_in:', tokenRes.data.expires_in, tokenRes.data.error || '');
    const { access_token, open_id, refresh_token, expires_in } = tokenRes.data;
    if (!access_token) {
      const reason = (tokenRes.data && (tokenRes.data.error_description || tokenRes.data.error)) || 'login_failed';
      console.error('TikTok token exchange failed:', reason);
      return res.redirect('outpost://auth/tiktok?error=' + encodeURIComponent(reason));
    }
    res.redirect(`outpost://auth/tiktok?token=${access_token}&userId=${open_id}&refreshToken=${refresh_token}&expiresIn=${expires_in}`);
    
    
  } catch (error) {
    console.error('TikTok auth error:', error.response?.data || error.message);
    res.redirect('outpost://auth/tiktok?error=login_failed');
  }
});

// ─── STORY COMPOSITE (text + filter baked into 1080x1920) ───
const sharp = require('sharp');

app.post('/story/compose', async (req, res) => {
  try {
    const { imageUrl, text, textColor, fontFamily, fontWeight, filter, textXPercent, textYPercent, textScale } = req.body;

    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    // 1. Download the source image
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imgBuffer = Buffer.from(imgResp.data);

    // 2. Resize/fit to exactly 1080x1920 (story size), filling the frame
    let pipeline = sharp(imgBuffer).resize(1080, 1920, { fit: 'cover' });

    // 3. Apply filter as a color tint overlay
    const filterTints = {
      none: null,
      cool: { r: 59, g: 130, b: 246, alpha: 0.18 },
      warm: { r: 249, g: 115, b: 22, alpha: 0.18 },
      bw: null, // handled via grayscale below
      fade: { r: 255, g: 255, b: 255, alpha: 0.15 },
      sepia: { r: 160, g: 120, b: 60, alpha: 0.28 },
      noir: { r: 0, g: 0, b: 0, alpha: 0.32 },
      sunset: { r: 236, g: 72, b: 153, alpha: 0.2 },
      mint: { r: 34, g: 197, b: 94, alpha: 0.16 },
      dusk: { r: 99, g: 102, b: 241, alpha: 0.22 },
      peach: { r: 251, g: 146, b: 120, alpha: 0.22 },
      frost: { r: 147, g: 197, b: 253, alpha: 0.2 },
    };

    if (filter === 'bw') {
      pipeline = pipeline.grayscale();
    }

    let baseBuffer = await pipeline.png().toBuffer();

    const composites = [];

    // Filter tint layer
    const tint = filterTints[filter];
    if (tint) {
      const tintSvg = Buffer.from(
        `<svg width="1080" height="1920"><rect width="1080" height="1920" fill="rgba(${tint.r},${tint.g},${tint.b},${tint.alpha})"/></svg>`
      );
      composites.push({ input: tintSvg, top: 0, left: 0 });
    }

    // 4. Text layer (if text exists)
    if (text && text.trim()) {
      const fontSize = Math.round(64 * (textScale || 1));
      const yPos = Math.round((textYPercent || 45) / 100 * 1920);
      const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const textSvg = Buffer.from(`
        <svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">
          <style>
            .txt { fill: ${textColor || '#ffffff'}; font-size: ${fontSize}px; font-family: ${fontFamily || 'sans-serif'}; font-weight: ${fontWeight || 700}; }
          </style>
          <text x="540" y="${yPos}" text-anchor="middle" class="txt">${escapedText}</text>
        </svg>
      `);
      composites.push({ input: textSvg, top: 0, left: 0 });
    }

    // 5. Composite everything
    const finalBuffer = await sharp(baseBuffer).composite(composites).jpeg({ quality: 95 }).toBuffer();

    // 6. Upload the finished image to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${finalBuffer.toString('base64')}`,
      { resource_type: 'image' }
    );

    res.json({ success: true, url: uploadResult.secure_url });
  } catch (error) {
    console.error('Story compose error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/ai/adapt', aiLimiter, async (req, res) => {
  try {
    const { caption } = req.body;
    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'No caption provided' });
    }
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: 'Rewrite this social media caption for TikTok. Keep the same voice, message and tone. Changes to make: put the hook in the very first line, cut the length by roughly half, and use no more than 4 hashtags. Do not add quotes, labels, or commentary. Return only the rewritten caption.\n\nCaption:\n' + caption,
      }],
    });
    const adapted = (msg.content && msg.content[0] && msg.content[0].text) ? msg.content[0].text.trim() : '';
    console.log('AI ADAPT:', adapted);
    res.json({ adapted });
  } catch (error) {
    console.error('AI adapt error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── AI: Improve Caption ───────────────────────────────
app.post('/ai/caption', aiLimiter, async (req, res) => {
  try {
    const { caption } = req.body;
    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'Caption is required' });
    }

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Rewrite this social media caption to be more engaging and punchy for Instagram. Keep it authentic and similar in length. Do not add hashtags. Return ONLY the improved caption with no quotes, no preamble, no explanation:\n\n${caption}`
      }]
    });

    const improved = msg.content[0].text.trim();
    res.json({ improved });
  } catch (error) {
    console.error('AI caption error:', error);
    res.status(500).json({ error: 'Could not improve caption' });
  }
});

// ─── AI: Suggest Hashtags ──────────────────────────────
app.post('/ai/hashtags', aiLimiter, async (req, res) => {
  try {
    const { caption } = req.body;
    if (!caption || !caption.trim()) {
      return res.status(400).json({ error: 'Caption is required' });
    }

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Suggest 8 relevant, popular Instagram hashtags for this caption. Return ONLY a comma-separated list of hashtags (each starting with #), no other text:\n\n${caption}`
      }]
    });

    const raw = msg.content[0].text.trim();
    const hashtags = raw.split(',').map(h => h.trim()).filter(h => h.startsWith('#'));
    res.json({ hashtags });
  } catch (error) {
    console.error('AI hashtags error:', error);
    res.status(500).json({ error: 'Could not suggest hashtags' });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'FocusPost server is running!' });
});

const SELF = 'http://localhost:' + (process.env.PORT || 3000);

async function refreshTiktokIfNeeded(acct) {
  const now = Date.now();
  if (acct.expires_at && Number(acct.expires_at) > now + 300000) return acct.access_token;
  if (!acct.refresh_token) return acct.access_token;
  try {
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: acct.refresh_token,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    if (access_token) {
      await pool.query(
        'UPDATE accounts SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE id=$4',
        [access_token, refresh_token || acct.refresh_token, Date.now() + (Number(expires_in) || 86400) * 1000, acct.id]
      );
      console.log('SCHEDULED TT TOKEN REFRESHED');
      return access_token;
    }
  } catch (e) {
    console.error('scheduled tt refresh failed:', e.response?.data || e.message);
  }
  return acct.access_token;
}

async function runScheduledPost(row) {
  const target = row.post_target;
  const mediaUrls = JSON.parse(row.media_urls || '[]');
  const mediaTypes = JSON.parse(row.media_types || '[]');
  const ttOptions = JSON.parse(row.tt_options || '{}');
  const isVideo = mediaTypes[0] === 'video';
  const publicIds = JSON.parse(row.public_ids || '[]');
  const igRatio = ttOptions.igRatio === 1 ? 'c_fill,g_center,w_1080,h_1080,f_jpg' : 'c_fill,g_center,w_1080,h_1350,f_jpg';
  const isStoryPost = row.post_mode === 'story';
  const igUrls = isVideo ? mediaUrls : publicIds.map(id => isStoryPost
    ? 'https://res.cloudinary.com/dmuxzxeiu/image/upload/' + id + '.jpg'
    : 'https://res.cloudinary.com/dmuxzxeiu/image/upload/' + igRatio + '/' + id + '.jpg');
  
  const ttUrls = isVideo ? mediaUrls : publicIds.map(id => 'https://api.purpost.app/media/p/' + id + '.jpg');
  const accts = await pool.query('SELECT * FROM accounts WHERE device_id=$1', [row.device_id]);
  const ig = accts.rows.find(a => a.platform === 'instagram');
  const tt = accts.rows.find(a => a.platform === 'tiktok');
  const errors = [];

  if (target === 'instagram' || target === 'both') {
    if (!ig) {
      errors.push('Instagram not connected');
    } else {
      const isStory = row.post_mode === 'story';
      const url = isStory ? SELF + '/post/instagram-story' : SELF + '/post/instagram';
      const body = isStory
      ? { mediaItems: [{ url: igUrls[0], type: isVideo ? 'video' : 'image' }], mute: !!ttOptions.isMuted, accessToken: ig.access_token, userId: ig.account_id }  
      
        : isVideo
          ? { caption: row.caption, mediaItems: [{ url: igUrls[0], type: 'video' }], accessToken: ig.access_token, userId: ig.account_id }
          : { caption: row.caption, imageUrls: igUrls, accessToken: ig.access_token, userId: ig.account_id };
      const r = await axios.post(url, body).catch(e => ({ data: { error: e.response?.data || e.message } }));
      if (r.data && r.data.error) errors.push('Instagram: ' + JSON.stringify(r.data.error).slice(0, 150));
    }
  }

  if (target === 'tiktok' || target === 'both') {
    if (!tt) {
      errors.push('TikTok not connected');
    } else {
      const token = await refreshTiktokIfNeeded(tt);
      const cap = (row.caption_tiktok && row.caption_tiktok.trim()) ? row.caption_tiktok : row.caption;
      const url = isVideo ? SELF + '/post/tiktok' : SELF + '/post/tiktok-photo';
      const body = isVideo
        ? { accessToken: token, videoUrl: ttUrls[0], caption: cap,
            privacyLevel: ttOptions.privacyLevel, disableComment: ttOptions.disableComment,
            disableDuet: ttOptions.disableDuet, disableStitch: ttOptions.disableStitch,
            brandOrganic: ttOptions.brandOrganic, brandedContent: ttOptions.brandedContent,
            aiGenerated: ttOptions.aiGenerated }
        : { accessToken: token, photoUrls: ttUrls, caption: cap, title: String(cap || '').slice(0, 90),
            privacyLevel: ttOptions.privacyLevel, disableComment: ttOptions.disableComment,
            brandOrganic: ttOptions.brandOrganic, brandedContent: ttOptions.brandedContent,
            aiGenerated: ttOptions.aiGenerated, autoAddMusic: ttOptions.autoAddMusic };
      
            const r = await axios.post(url, body).catch(e => ({ data: { success: false, error: e.response?.data || e.message } }));
      if (!r.data || !r.data.success) {
        errors.push('TikTok: ' + JSON.stringify(r.data && r.data.error).slice(0, 150));
      } else {
        const publishId = r.data.publishId;
        let final = null;
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          try {
            const s = await axios.post(
              'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
              { publish_id: publishId },
              { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' } }
            );
            const st = s.data && s.data.data && s.data.data.status;
            console.log('SCHEDULED TT STATUS:', row.id, st);
            if (st === 'PUBLISH_COMPLETE' || st === 'FAILED') { final = s.data.data; break; }
          } catch (e) {
            console.error('scheduled tt status error:', e.response?.data || e.message);
          }
        }
        if (!final) errors.push('TikTok: still processing after 60 seconds');
        else if (final.status === 'FAILED') errors.push('TikTok: ' + (final.fail_reason || 'rejected during processing'));
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join(' | '));
}

setInterval(async () => {
  try {
    const due = await pool.query(
      "SELECT * FROM scheduled_posts WHERE status='pending' AND fire_at <= $1 ORDER BY fire_at ASC LIMIT 5",
      [Date.now()]
    );
    for (const row of due.rows) {
      await pool.query("UPDATE scheduled_posts SET status='running' WHERE id=$1", [row.id]);
      try {
        await runScheduledPost(row);
        await pool.query("UPDATE scheduled_posts SET status='done' WHERE id=$1", [row.id]);
        console.log('SCHEDULE FIRED OK:', row.id);
        sendPush(row.device_id, 'Posted', 'Your scheduled post went out.');
        const pids = JSON.parse(row.public_ids || '[]');
        if (pids.length > 0) {
          const rt = (JSON.parse(row.media_types || '[]')[0] === 'video') ? 'video' : 'image';
          setTimeout(() => {
            cloudinary.api.delete_resources(pids, { resource_type: rt })
              .then(() => console.log('SCHEDULED MEDIA CLEANED:', row.id))
              .catch((e) => console.error('cleanup failed:', e.message));
          }, 120000);
        }
      } catch (e) {
        const attempts = (row.attempts || 0) + 1;
        const failed = attempts >= 3;
        await pool.query(
          'UPDATE scheduled_posts SET status=$1, attempts=$2, fail_reason=$3 WHERE id=$4',
          [failed ? 'failed' : 'pending', attempts, String(e.message).slice(0, 400), row.id]
        );
        console.error('SCHEDULE FAILED:', row.id, 'attempt', attempts, e.message);
        if (failed) sendPush(row.device_id, 'Post failed', String(e.message).slice(0, 120));
      }
    }
  } catch (e) {
    console.error('scheduler tick error:', e.message);
  }
}, 60000);

const PORT = process.env.PORT || 3000;

// ─── LEGAL PAGES v2 ─────────────────────────────────────────────
// REPLACES the earlier legal block in server.js.
// Delete the old "LEGAL PAGES" block first, then paste this in its place.
// Serves:  https://api.purpost.app/privacy   and   /terms

const LEGAL_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0b121e;color:#c8d2de;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       line-height:1.7;padding:48px 22px 90px;font-size:15.5px}
  .wrap{max-width:760px;margin:0 auto}
  .brand{font-size:13px;font-weight:800;letter-spacing:2.6px;color:#f97316;text-transform:uppercase;margin-bottom:10px}
  h1{color:#fff;font-size:30px;font-weight:800;letter-spacing:-0.6px;margin-bottom:6px}
  .date{color:#64748b;font-size:13px;margin-bottom:38px}
  h2{color:#fff;font-size:18px;font-weight:700;margin:34px 0 10px}
  h3{color:#dbe3ec;font-size:15.5px;font-weight:700;margin:22px 0 8px}
  p{margin-bottom:14px}
  ul{margin:0 0 16px 20px}
  li{margin-bottom:8px}
  a{color:#f97316;text-decoration:none}
  a:hover{text-decoration:underline}
  strong{color:#e7edf5}
  .box{background:rgba(249,115,22,0.07);border:1px solid rgba(249,115,22,0.22);
       border-radius:10px;padding:16px 18px;margin:20px 0}
  .box p:last-child{margin-bottom:0}
  .foot{margin-top:52px;padding-top:22px;border-top:1px solid rgba(255,255,255,0.08);
        color:#55637a;font-size:13px}
`;

function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Purpost</title><style>${LEGAL_CSS}</style></head>
<body><div class="wrap">
<div class="brand">Purpost</div>
${bodyHtml}
<div class="foot">Purpost is operated by Bowen Digital LLC, a Florida limited liability company.<br>
Contact: <a href="mailto:support@purpost.app">support@purpost.app</a></div>
</div></body></html>`;
}

app.get('/privacy', (req, res) => {
  res.type('html').send(legalPage('Privacy Policy', `
<h1>Privacy Policy</h1>
<div class="date">Last updated: September 18, 2026</div>

<p>Purpost is a mobile application that lets you publish content to Instagram and TikTok from one place. This policy explains what we collect, why we collect it, who we share it with, and how to get rid of it.</p>

<div class="box">
<p><strong>We do not sell your personal information. We do not share it with advertisers. We do not use your content to train AI models.</strong> We share data only with the service providers listed below, and only to the extent required to make the app work.</p>
</div>

<h2>1. Who we are</h2>
<p>Purpost is operated by Bowen Digital LLC, a Florida limited liability company ("we," "us," "our"). You can reach us at <a href="mailto:support@purpost.app">support@purpost.app</a>.</p>

<h2>2. What we collect</h2>
<p>Purpost has no user accounts. We never ask for your name, email address, phone number, date of birth, payment details, precise location, or contacts. We do not use advertising identifiers or third-party analytics or tracking SDKs.</p>
<ul>
  <li><strong>A device identifier.</strong> A random value generated on your device the first time you open the app. It links your connected accounts and scheduled posts to your installation. It is not derived from any hardware identifier, is not shared with third parties, and does not identify you personally.</li>
  <li><strong>Social account credentials.</strong> When you connect Instagram or TikTok, that platform issues us an access token (and for TikTok, a refresh token). We store the token, your platform account ID, and your username so we can publish on your behalf.</li>
  <li><strong>Content you choose to publish.</strong> Photos, videos, and captions you submit through the app.</li>
  <li><strong>Scheduled post details.</strong> What you scheduled, when it should publish, and whether it succeeded or failed.</li>
  <li><strong>A push notification token</strong>, only if you grant notification permission, so we can tell you when a scheduled post publishes or fails.</li>
  <li><strong>Server logs.</strong> Our hosting provider records standard request logs, which may include IP address and timestamps, for security and troubleshooting.</li>
</ul>

<h2>3. Why we collect it</h2>
<ul>
  <li>To publish and schedule your posts on the platforms you connect</li>
  <li>To show you your own posts, comments, and performance data from those platforms</li>
  <li>To send you notifications about your scheduled posts</li>
  <li>To generate caption suggestions, only when you request them</li>
  <li>To keep the service secure, diagnose failures, and prevent abuse</li>
</ul>

<h2>4. Service providers</h2>
<p>Purpost cannot function without these providers. Each receives only what it needs, and none are permitted to use your data for their own purposes:</p>
<ul>
  <li><strong>Meta Platforms (Instagram)</strong> — publishing, comments, and insights for your connected Instagram account</li>
  <li><strong>TikTok</strong> — publishing and post data for your connected TikTok account</li>
  <li><strong>Cloudinary</strong> — hosting of your media so the platforms can retrieve it during publishing</li>
  <li><strong>Anthropic</strong> — caption suggestions. Only the caption text you submit is sent, and only when you tap an AI option. It is not used to train models.</li>
  <li><strong>Expo</strong> — delivery of push notifications</li>
  <li><strong>Railway</strong> — hosting for our server and database</li>
</ul>
<p>We may also disclose information if required by law, to enforce our Terms, or to protect the rights, safety, or property of our users or ourselves.</p>

<h2>5. Where your data is held</h2>
<p>Our servers and database are located in the United States. If you use Purpost from outside the United States, your information will be transferred to and processed in the United States, where privacy laws may differ from those in your country.</p>

<h2>6. How long we keep it</h2>
<ul>
  <li><strong>Access tokens</strong> are retained until you disconnect the account, the platform expires them, or you request deletion.</li>
  <li><strong>Media attached to scheduled posts</strong> is deleted automatically after the post publishes.</li>
  <li><strong>Media from immediate posts</strong> is uploaded so the platforms can retrieve it during publishing and may remain in our media provider's storage after publishing. You can request its deletion at any time by emailing us.</li>
  <li><strong>Scheduled posts</strong> are retained until they publish or you cancel them.</li>
  <li><strong>Drafts and post history</strong> are stored on your device, not on our servers.</li>
  <li><strong>Server logs</strong> are retained on a rolling basis by our hosting provider for operational purposes.</li>
</ul>

<h2>7. Your choices and rights</h2>
<h3>Deleting your data</h3>
<ul>
  <li><strong>Disconnect Instagram or TikTok in Settings.</strong> This deletes that account's tokens from our database.</li>
  <li><strong>Delete the app.</strong> This removes all locally stored data, including drafts and post history.</li>
  <li><strong>Email <a href="mailto:support@purpost.app">support@purpost.app</a></strong> to request deletion of any remaining server-side data tied to your device, including stored media. We will action requests within 30 days.</li>
</ul>
<h3>Revoking platform access</h3>
<p>Disconnecting in Purpost removes the token from our database. Because the token was issued by Instagram or TikTok, it may remain valid on their systems until it expires. To revoke it completely, remove Purpost from that platform's own app permissions — Instagram: Settings → Apps and websites; TikTok: Settings → Security → Manage app permissions.</p>

<h3>If you are in California</h3>
<p>Under the CCPA/CPRA you have the right to know what personal information we collect, to request deletion, to correct inaccurate information, and not to be discriminated against for exercising those rights. <strong>We do not sell or share personal information as those terms are defined under California law.</strong> To exercise any right, email <a href="mailto:support@purpost.app">support@purpost.app</a>.</p>

<h3>If you are in the EU, EEA or UK</h3>
<p>Our lawful basis for processing is performance of a contract — we process your data to deliver the service you asked for — and, for security and troubleshooting, our legitimate interests. You have the right to access, correct, delete, restrict, or object to processing of your personal data, and the right to data portability. You may also lodge a complaint with your local supervisory authority. To exercise any right, email <a href="mailto:support@purpost.app">support@purpost.app</a>.</p>

<h2>8. Security</h2>
<p>All traffic between the app, our servers, and the platforms uses HTTPS. Access tokens are stored in a private database that is not publicly reachable, and we deliberately collect as little as possible so there is less to expose. No system is perfectly secure, and we cannot guarantee absolute security. If we become aware of a breach affecting your information, we will notify affected users and any regulator required by law, without undue delay.</p>

<h2>9. Children</h2>
<p>Purpost is not directed to children under 13, and we do not knowingly collect personal information from them. Instagram and TikTok also require users to be at least 13. If you believe a child under 13 has provided us information, email us and we will delete it.</p>

<h2>10. Third-party services</h2>
<p>Purpost links to and integrates with services we do not control, including Instagram and TikTok. Their handling of your data is governed by their own privacy policies, not this one.</p>

<h2>11. Changes to this policy</h2>
<p>We may update this policy. If the change is material, we will update the date above and notify you in the app before it takes effect. Continued use after an update means you accept the revised policy.</p>

<h2>12. Contact</h2>
<p>Questions, requests, or complaints: <a href="mailto:support@purpost.app">support@purpost.app</a></p>
`));
});

app.get('/terms', (req, res) => {
  res.type('html').send(legalPage('Terms of Service', `
<h1>Terms of Service</h1>
<div class="date">Last updated: September 18, 2026</div>

<p>These Terms of Service ("Terms") are a binding agreement between you and Bowen Digital LLC, a Florida limited liability company ("we," "us," "our"), governing your use of the Purpost mobile application and related services (the "Service"). By downloading, accessing, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.</p>

<h2>1. What Purpost does</h2>
<p>Purpost lets you create a post once and publish it to Instagram and TikTok. We provide a tool. We do not host, distribute, moderate, or control what you publish — the platforms you publish to do that, under their own rules.</p>

<h2>2. Eligibility</h2>
<p>You must be at least 13 years old to use the Service, and old enough to form a binding contract where you live. If you use the Service on behalf of a business, you represent that you are authorised to bind that business to these Terms.</p>

<h2>3. Licence</h2>
<p>We grant you a limited, personal, non-exclusive, non-transferable, revocable licence to use the Service for its intended purpose. You may not sublicense, resell, or make the Service available to third parties.</p>

<h2>4. Your content</h2>
<ul>
  <li><strong>You keep all rights to your content.</strong> We claim no ownership of anything you publish through Purpost.</li>
  <li>You grant us a limited licence to store, process, format, and transmit your content solely to deliver the Service — publishing it where you tell us to. This licence ends when the content is deleted from our systems.</li>
  <li>You are solely responsible for your content and for holding all rights, licences, and permissions necessary to publish it, including for any music, images, or footage you did not create.</li>
</ul>

<h2>5. Acceptable use</h2>
<p>You agree not to use the Service to:</p>
<ul>
  <li>Publish content that is unlawful, defamatory, harassing, hateful, sexually exploitative, or that infringes anyone's intellectual property or privacy rights</li>
  <li>Violate Instagram's, TikTok's, or Apple's terms, policies, or platform rules</li>
  <li>Send spam, engage in coordinated inauthentic behaviour, or publish automated bulk content in violation of platform rules</li>
  <li>Reverse engineer, decompile, or attempt to extract source code from the Service</li>
  <li>Interfere with, overload, or attempt to gain unauthorised access to the Service, our servers, or other users' data</li>
  <li>Use the Service to build a competing product</li>
</ul>
<p>We may suspend or terminate access immediately for any violation of this section.</p>

<h2>6. Connected platforms</h2>
<p>Using Purpost to publish means you also agree to the terms of the platform you publish to. Those platforms may change their APIs, restrict or revoke access, rate-limit requests, reject media, or remove your content at any time and without notice to us. <strong>We do not control those decisions and are not responsible for them.</strong> Features of the Service may change or stop working as a result.</p>

<h2>7. Intellectual property complaints</h2>
<p>If you believe content published through Purpost infringes your copyright, note that we do not host published content — it lives on Instagram or TikTok, and those platforms operate their own takedown processes, which are the fastest route. You may also contact us at <a href="mailto:support@purpost.app">support@purpost.app</a> with details of the work, the allegedly infringing material, your contact information, and a statement made in good faith. We will respond to valid notices and may terminate the accounts of repeat infringers.</p>

<h2>8. Feedback</h2>
<p>If you send us ideas, suggestions, or feedback, you grant us an unrestricted, royalty-free right to use them without obligation or compensation to you.</p>

<h2>9. Service availability and pre-release status</h2>
<p>We work to keep the Service running but do not guarantee it will be uninterrupted, timely, secure, or error-free. Posts may fail for reasons outside our control, including platform outages, rate limits, expired credentials, or media a platform rejects. The Service may be offered in beta or early-access form and may contain defects. We may modify, suspend, or discontinue any part of the Service at any time.</p>

<h2>10. Disclaimer of warranties</h2>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, OR NON-INFRINGEMENT. WE DO NOT WARRANT THAT POSTS WILL PUBLISH SUCCESSFULLY, THAT DATA WILL NOT BE LOST, OR THAT THE SERVICE WILL MEET YOUR REQUIREMENTS. Some jurisdictions do not allow the exclusion of implied warranties, so parts of this section may not apply to you.</p>

<h2>11. Limitation of liability</h2>
<p>TO THE FULLEST EXTENT PERMITTED BY LAW, BOWEN DIGITAL LLC AND ITS MEMBERS, OFFICERS, AND AGENTS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOST POSTS, LOST CONTENT, LOST REACH, LOST FOLLOWERS, LOST PROFITS, LOST REVENUE, LOST DATA, OR BUSINESS INTERRUPTION, ARISING FROM OR RELATED TO YOUR USE OF THE SERVICE, WHETHER BASED IN CONTRACT, TORT, OR ANY OTHER THEORY, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</p>
<p>OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE TOTAL AMOUNT YOU PAID US IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE, OR (B) ONE HUNDRED U.S. DOLLARS ($100).</p>
<p>Some jurisdictions do not allow certain limitations, so parts of this section may not apply to you.</p>

<h2>12. Indemnification</h2>
<p>You agree to indemnify, defend, and hold harmless Bowen Digital LLC and its members, officers, and agents from any claims, demands, damages, losses, liabilities, and expenses (including reasonable legal fees) arising from or related to: (a) your content; (b) your use of the Service; (c) your violation of these Terms; (d) your violation of any platform's terms or policies; or (e) your violation of any law or the rights of any third party.</p>

<h2>13. Termination</h2>
<p>You may stop using the Service at any time by disconnecting your accounts and deleting the app. We may suspend or terminate your access at any time, with or without notice, if you violate these Terms, if required by a platform we depend on, or if we discontinue the Service. Sections 4, 8, 10, 11, 12, 14 and 15 survive termination.</p>

<h2>14. Disputes and governing law</h2>
<p><strong>Informal resolution first.</strong> If you have a dispute, email <a href="mailto:support@purpost.app">support@purpost.app</a> and we will try in good faith to resolve it within 30 days before either side starts formal proceedings.</p>
<p>These Terms are governed by the laws of the State of Florida, without regard to its conflict of law principles. You and we agree that any dispute not resolved informally will be brought exclusively in the state or federal courts located in Florida, and you consent to the personal jurisdiction of those courts. Nothing here prevents either party from seeking injunctive relief, or from bringing an individual claim in small claims court.</p>

<h2>15. General</h2>
<ul>
  <li><strong>Entire agreement.</strong> These Terms and the Privacy Policy are the entire agreement between you and us regarding the Service.</li>
  <li><strong>Severability.</strong> If any provision is found unenforceable, the rest remains in effect and the unenforceable provision will be limited to the minimum extent necessary.</li>
  <li><strong>No waiver.</strong> Our failure to enforce any provision is not a waiver of it.</li>
  <li><strong>Assignment.</strong> You may not assign these Terms. We may assign them in connection with a merger, acquisition, or sale of assets.</li>
  <li><strong>Force majeure.</strong> We are not liable for failures caused by events beyond our reasonable control.</li>
  <li><strong>Apple.</strong> If you obtained the app from the App Store, you acknowledge these Terms are between you and us, not Apple; Apple has no obligation to provide support or handle any claim relating to the app; and Apple is a third-party beneficiary of these Terms with the right to enforce them.</li>
</ul>

<h2>16. Changes</h2>
<p>We may update these Terms. If a change is material, we will update the date above and notify you in the app. Continued use after an update means you accept the revised Terms.</p>

<h2>17. Contact</h2>
<p><a href="mailto:support@purpost.app">support@purpost.app</a></p>
`));
});
// ─── END LEGAL PAGES v2 ─────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`FocusPost server running on port ${PORT}`);
});


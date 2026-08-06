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
    console.log('DB READY');
  } catch (e) {
    console.error('DB init failed:', e.message);
  }
})();


const app = express();
app.use(cors());
app.use(express.json());


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
      const upload = await cloudinary.uploader.upload(item.url, uploadOptions);
      const publicUrl = upload.secure_url;

      const containerPayload = isVideo
        ? { media_type: 'REELS', video_url: publicUrl, caption: caption, access_token: accessToken }
        : { image_url: publicUrl, caption: caption, access_token: accessToken };

      const containerRes = await axios.post(
        `https://graph.instagram.com/v18.0/${userId}/media`,
        containerPayload
      );
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

app.post('/schedule/create', async (req, res) => {
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

app.get('/schedule/list', async (req, res) => {
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

app.post('/schedule/cancel', async (req, res) => {
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

app.post('/schedule/reschedule', async (req, res) => {
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

app.post('/account/save', async (req, res) => {
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
    console.log('ACCOUNT SAVED:', deviceId, platform);
    res.json({ success: true });
  } catch (e) {
    console.error('account save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/account/delete', async (req, res) => {
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

// — PRIVACY POLICY —
app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h1>Outpost Privacy Policy</h1>
        <p>Outpost collects your Instagram account information solely to enable posting on your behalf. We do not sell or share your data with third parties.</p>
        <p>You can revoke access at any time through your Instagram settings.</p>
        <p>Contact: bowenjumanne@gmail.com</p>
      </body>
    </html>
  `);
});

app.get('/auth/instagram/login', (req, res) => {
  console.log('Instagram login route hit');

  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=2097065204178856&redirect_uri=https://api.outpostcreator.com/auth/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments&response_type=code`;

  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: '2097065204178856',
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: 'https://api.outpostcreator.com/auth/instagram/callback',
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
const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload,video.publish&response_type=code&redirect_uri=https://api.outpostcreator.com/auth/tiktok/callback&state=outpost`;
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
        redirect_uri: 'https://api.outpostcreator.com/auth/tiktok/callback',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
   console.log('TIKTOK TOKEN RESPONSE:', JSON.stringify(tokenRes.data));
    const { access_token, open_id, refresh_token, expires_in } = tokenRes.data;
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

app.post('/ai/adapt', async (req, res) => {
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
app.post('/ai/caption', async (req, res) => {
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
app.post('/ai/hashtags', async (req, res) => {
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
  const igRatio = ttOptions.igRatio === 1 ? 'c_fill,g_auto,w_1080,h_1080,f_jpg' : 'c_fill,g_auto,w_1080,h_1350,f_jpg';
  const igUrls = isVideo ? mediaUrls : publicIds.map(id => 'https://res.cloudinary.com/dmuxzxeiu/image/upload/' + igRatio + '/' + id + '.jpg');
  const ttUrls = isVideo ? mediaUrls : publicIds.map(id => 'https://api.outpostcreator.com/media/p/' + id + '.jpg');
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
        ? { mediaItems: [{ url: igUrls[0], type: isVideo ? 'video' : 'image' }], accessToken: ig.access_token, userId: ig.account_id }
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
      if (!r.data || !r.data.success) errors.push('TikTok: ' + JSON.stringify(r.data && r.data.error).slice(0, 150));
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
        const pids = JSON.parse(row.public_ids || '[]');
        if (pids.length > 0) cloudinary.api.delete_resources(pids).catch(() => {});
      } catch (e) {
        const attempts = (row.attempts || 0) + 1;
        const failed = attempts >= 3;
        await pool.query(
          'UPDATE scheduled_posts SET status=$1, attempts=$2, fail_reason=$3 WHERE id=$4',
          [failed ? 'failed' : 'pending', attempts, String(e.message).slice(0, 400), row.id]
        );
        console.error('SCHEDULE FAILED:', row.id, 'attempt', attempts, e.message);
      }
    }
  } catch (e) {
    console.error('scheduler tick error:', e.message);
  }
}, 60000);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FocusPost server running on port ${PORT}`);
});


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


// ─── TIKTOK ───────────────────────────────────────────────
app.post('/post/tiktok', async (req, res) => {
  try {
    const { accessToken, videoUrl, caption } = req.body;

    const response = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption,
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({ success: true, data: response.data });
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

  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=920676630923363&redirect_uri=https://focuspost-server-production.up.railway.app/auth/instagram/callback&scope=instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments&response_type=code`;

  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await axios.post(
      'https://api.instagram.com/oauth/access_token',
      new URLSearchParams({
        client_id: '920676630923363',
        client_secret: process.env.INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: 'https://focuspost-server-production.up.railway.app/auth/instagram/callback',
        code: code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
        const userRes = await axios.get(
          `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${access_token}`
        );
        const username = userRes.data.username;
        const userId = userRes.data.id;
        res.redirect(`outpost://auth?token=${access_token}&userId=${userId}&username=${username}`);
          } catch (error) {
            console.error('Instagram callback error:', error.response?.data || error.message);
            res.redirect('outpost://auth?error=login_failed');
          }
        });

   

// ─── TIKTOK AUTH ──────────────────────────────────────────
app.get('/auth/tiktok/login', (req, res) => {
 const authUrl = `https://www.tiktok.com/v2/auth/authorize?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.upload&response_type=code&redirect_uri=https://focuspost-server-production.up.railway.app/auth/tiktok/callback&state=outpost`;
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
        redirect_uri: 'https://focuspost-server-production.up.railway.app/auth/tiktok/callback',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, open_id } = tokenRes.data;
    res.redirect(`outpost://auth/tiktok?token=${access_token}&userId=${open_id}`);
  } catch (error) {
    console.error('TikTok auth error:', error.response?.data || error.message);
    res.redirect('outpost://auth/tiktok?error=login_failed');
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'FocusPost server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FocusPost server running on port ${PORT}`);
});


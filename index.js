const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const axios = require('axios');
// const Redis = require("ioredis");
const { v4: uuid } = require('uuid');
const Redis = require("@upstash/redis")
const Jimp = require('jimp');

functions.http('a1execprodv2', async (req, res) => {
  console.log(`🪵:a1execprodv2:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const s3Client = new S3Client({ region: "us-east-1" });
  // let redisClient = new Redis(process.env.REDIS_CONNECTION_URL)
  const redis = new Redis.Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
  const { id, userId, model, endpoint, sd_model_checkpoint, params } = req.body
  const log_event = ({ event, data }) => {
    axios.post('https://a1execprodlogs-ake5r4huta-ue.a.run.app', { id, event, ts: new Date(), data })
  }
  log_event({ event: 'executorStarted' })
  try {
    // 🌳 update option (model) to worker load balancer
    let entryPointUrl
    switch (sd_model_checkpoint) {
      case 'lofi_V2pre':
        entryPointUrl = 'http://lofi-loadbalancer-2039171330.us-east-1.elb.amazonaws.com'
        break
      case 'rpg_V4':
        entryPointUrl = 'http://rpg-loadbalancer-183494936.us-east-1.elb.amazonaws.com'
        break
      case 'meinamix_meinaV8':
        entryPointUrl = 'http://waifu-loadBalancer-82144410.us-east-1.elb.amazonaws.com'
        break
      case 'deliberate_v2':
        entryPointUrl = 'http://deliberate-loadBalancer-269090339.us-east-1.elb.amazonaws.com'
        break
    }
    const updateOption = async () => {
      const configApiUrl = `${entryPointUrl}/sdapi/v1/options`
      console.log('configApiUrl: ', configApiUrl)
      try {
        await axios.post(
          configApiUrl,
          { sd_model_checkpoint },
          { headers: { 'Content-Type': 'application/json' } }
        )
      } catch (error) {
        console.log('🔴', 'updateOption error', error.message)
        log_event({ event: 'executorOptionUpdateFailed', data: error.message })
        throw error
      }
    }
    await updateOption()
    log_event({ event: 'executorOptionUpdated' })
    // 🌳 send request to worker
    const url = `${entryPointUrl}${endpoint}` // endpoint: `/sdapi/v1/txt2img`,
    const response = await axios.post(url, params)
    console.log('🪵', 'Object.keys(response.data)', Object.keys(response.data))
    log_event({ event: 'executorInferenceResponseReceived' })
    // 🌳 parse response and store image to S3
    const { images, parameters, info } = response.data
    /* Add two numbers and
      Watermark image received from stable diffusion
   */
    //function
    const watermarkImage = async (image, index) => {
      const img = await Jimp.read(Buffer.from(image, 'base64'));
      const font = await Jimp.loadFont('font/kWv9rCk2dPIXDhez8BSwUmTq.ttf.fnt');
      let textImage = new Jimp(120, 20, '#FFFFFF');
      textImage.print(font, 1, 0, "anydream.xyz");
      textImage.color([{ apply: 'xor', params: ['#FFFFFF'] }]);
      img.blit(textImage, img.bitmap.width - 120, img.bitmap.height - 20)
      // img.write(`out${index}.png`);
      const watermarkBase64 = await img.getBase64Async(img._originalMime);
      return { realImg: image, watermarkImg: watermarkBase64 };
    }
    // function end
    const results = await Promise.all(images.map((img, index) => watermarkImage(img, index)));
    // Watermark end

    const parsedInfo = JSON.parse(info)
    const imgIds = results.map((result, index) => `${uuid()}`)
    if (images.length > 0) {
      // save watermarked image
      const promiseArrWatermark = results.map(async (image, index) => {
        const { watermarkImg } = image; // Have both watermark image and normal image
        console.log(imgIds[index])
        let base64Data = watermarkImg.replace(/^data:image\/png;base64,/, "");
        return s3Client.send(new PutObjectCommand({
          Bucket: "a1-generated",
          Key: `watermarked/${imgIds[index]}.png`,
          Body: Buffer.from(base64Data, 'base64'),
          ContentType: 'image/png'
        }))
      })
      // save original (for future training or premium users)
      const promiseArrOriginal = images.map((image, index) => {
        return s3Client.send(new PutObjectCommand({
          Bucket: "a1-generated",
          Key: `generated/${imgIds[index]}.png`,
          Body: Buffer.from(image, 'base64'),
          ContentType: 'image/png'
        }))
      })
      const responses = await Promise.all([...promiseArrWatermark, ...promiseArrOriginal])
      for (let response of responses) {
        console.log(response.$metadata.httpStatusCode)
        if (response.$metadata.httpStatusCode !== 200) {
          throw new Error('S3 upload failed')
        }
      }
      console.log('🪵', 'S3 upload success')
      log_event({ event: 'executorS3Updated' })
    }

    // get GrantBalance from redis
    let tokenPaidGrantBalanceArray = await redis.get(`paidGrantBalance:${userId}`)
    let freeGrantUsage = await redis.get(`freeGrantUsage:${userId}`)
    let grantToCharge
    let tokenCost = images.length * 2
    let remainingTokenCost = tokenCost

    if (tokenPaidGrantBalanceArray && Array.isArray(tokenPaidGrantBalanceArray)) {
      tokenPaidGrantBalanceArray = tokenPaidGrantBalanceArray.filter(grant => grant.expiresAt > (new Date()).toISOString())
        .sort((a, b) => a.expiresAt > b.expiresAt ? 1 : -1)
      grantToCharge = tokenPaidGrantBalanceArray[0]
      for (let grant of tokenPaidGrantBalanceArray) {
        if (grant.amount >= remainingTokenCost) {
          grant.amount -= remainingTokenCost
          remainingTokenCost = 0
          tokenPaidGrantBalanceArray = [...tokenPaidGrantBalanceArray.filter(g => g.id !== grant.id), grant]
          break
        } else {
          remainingTokenCost -= grant.amount
          grant.amount = 0
          tokenPaidGrantBalanceArray = [...tokenPaidGrantBalanceArray.filter(g => g.id !== grant.id), grant]
        }
      }
      await redis.set(`paidGrantBalance:${userId}`, tokenPaidGrantBalanceArray)
      if (remainingTokenCost > 0 && freeGrantUsage && Array.isArray(freeGrantUsage)) {
        freeGrantUsage = freeGrantUsage.filter(usage => usage.epochTs > (new Date()).getTime() - 3600 * 1000)
        freeGrantUsage.push({ epochTs: new Date().getTime(), amount: remainingTokenCost })
        await redis.set(`freeGrantUsage:${userId}`, freeGrantUsage)
      }
    }

    // 🌳 update supabase
    await supabase
      .from('a1_request')
      .update({
        id,
        status: 'success',
        inferenceParameters: parameters,
        inferenceInfo: info,
        completedAt: new Date(),
      })
      .eq('id', id)
    await supabase
      .from('image')
      .insert(imgIds.map((imgId) => ({
        id: imgId,
        requestId: id,
        userId,
        model,
        createdAt: new Date(),
        requestParams: params,
        seed: parsedInfo.seed,
        tokenGrantId: grantToCharge && grantToCharge.id,
        tokenCost,
      })))

    console.log('✅', 'image gen success')
    log_event({ event: 'executorRequestSupabaseUpdated' })
    // 🌳 call moderation
    for (let imgId of imgIds) {
      axios.post(`https://a1moderatorv2-ake5r4huta-ue.a.run.app`, { id: imgId, requestParams: params, sd_model_checkpoint })
    }

    // 🌳 return response (not used except for debugging)
    res.send({
      requestId: id,
      endpoint,
      sd_model_checkpoint,
      params,
      userId,
      model,
      status: 'success',
      inferenceParameters: parameters,
      inferenceInfo: info,
    });
  } catch (error) {
    await supabase
      .from('a1_request')
      .update({
        id,
        status: 'server_error',
        updatedAt: new Date()
      })
      .eq('id', id)
    log_event({ event: 'executorError', data: error.message })
    console.error('🔴', "got error: ", error);
    res.status(500).send(error);
  }
});
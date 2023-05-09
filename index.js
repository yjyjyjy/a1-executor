const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const axios = require('axios');
const { v4: uuid } = require('uuid');
const Redis = require("@upstash/redis")
const Jimp = require('jimp');

functions.http('a1execprodv2', async (req, res) => {
  console.log(`🪵:a1execprodv2:${JSON.stringify(req.body)}`)
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const s3Client = new S3Client({ region: "us-east-1" });
  const redis = new Redis.Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
  const { id, userId, model, endpoint, sd_model_checkpoint } = req.body
  let { params } = req.body;
  const log_event = ({ event, data }) => {
    axios.post('https://a1execprodlogs-ake5r4huta-ue.a.run.app', { id, event, ts: new Date(), data })
  }
  log_event({ event: 'executorStarted' })
  try {

    // 🌳 token balance gate keeper
    let tokenBal = await redis.get(`tokenBal:${userId}`)
    console.log('11.tokenBal', tokenBal)
    let tokenBalanceAmount = 0
    let tokenCost = params.batch_size * 2 || 2
    if (tokenBal && Array.isArray(tokenBal)) {
      console.log('calculating token balance')
      tokenBalanceAmount = tokenBal.reduce((acc, grant) => {
        if ((grant.expiresAt > new Date().getTime() || grant.type === 'free') && grant.amount > 0) {
          acc += grant.amount
        }
        return acc
      }, 0)
    }
    console.log('22.tokenBal: ', tokenBal)
    console.log('tokenBalanceAmount: ', tokenBalanceAmount)
    console.log('tokenCost: ', tokenCost)
    if (!tokenBal || !Array.isArray(tokenBal) || tokenCost > tokenBalanceAmount) {
      await supabaseAdmin
        .from('a1_request')
        .update({
          id,
          status: 'token_balance_error',
          completedAt: new Date(),
        })
        .eq('id', id)
      throw new Error('token_balance_error')
    }


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
    if (endpoint.includes('img2img')) {
      const imgId = params.init_images[0];
      const command = new GetObjectCommand({
        Bucket: 'a1-generated',
        Key: `generated/${imgId}.png`,
      });

      try {
        const response = await s3Client.send(command);
        const imgStr = await response.Body.transformToString("base64");
        params = {
          ...params,
          init_images: [imgStr.replace(/^data:image\/png;base64,/, "")]
        }
      } catch (err) {
        console.log(err);
        throw new Error("Error while geting image form s3 for img2img endpint!")
      }
    }
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
      const font = await Jimp.loadFont('font/K3B16nsnVT8_H8GuelL64TwZ.ttf.fnt');
      let textImage = new Jimp(140, 30, '#FFFFFF');
      textImage.print(font, 1, 0, "anydream.xyz");
      textImage.color([{ apply: 'xor', params: ['#FFFFFF'] }]);
      img.blit(textImage, img.bitmap.width - 140, img.bitmap.height - 30)
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
      const promiseArrWatermark = results.map((image, index) => {
        const { watermarkImg } = image; // Have both watermark image and normal image
        console.log('watermark')
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
        console.log('original')
        console.log(imgIds[index])
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

    // token balance v2:
    remainingTokenCost = tokenCost
    // let tokenBal = await redis.get(`tokenBal:${userId}`)
    // if (tokenBal && Array.isArray(tokenBal)) {
    console.log('tokenBal: ', JSON.stringify(tokenBal))
    tokenBal = tokenBal.filter(grant => (grant.expiresAt > new Date().getTime() && grant.amount > 0) || grant.type === 'free')
    tokenBal.sort((a, b) => a.expiresAt > b.expiresAt ? 1 : -1)
    tokenBal = tokenBal.reduce((acc, grant) => {
      const amount = Math.min(grant.amount, remainingTokenCost)
      remainingTokenCost -= amount
      grant.amount -= amount
      if (grant.type === 'free' && amount > 0) {
        if (!grant.spend) { grant.spend = [] }
        grant.spend = [...grant.spend, { ts: new Date().getTime(), amount }]
      }
      return grant.amount > 0 || grant.type === 'free' ? [...acc, grant] : acc
    }, [])
    console.log('tokenBal: ', JSON.stringify(tokenBal))
    await redis.set(`tokenBal:${userId}`, tokenBal)
    // }

    // 🌳 update supabase
    await supabaseAdmin
      .from('a1_request')
      .update({
        id,
        status: 'success',
        inferenceParameters: parameters,
        inferenceInfo: info,
        completedAt: new Date(),
      })
      .eq('id', id)

    // this is the params to store in supabase
    let requestParams = { ...params }
    delete requestParams.init_images
    delete requestParams.mask
    delete requestParams.inpaint_full_res
    delete requestParams.inpaint_full_res_padding

    await supabaseAdmin
      .from('image')
      .insert(imgIds.map((imgId) => ({
        id: imgId,
        requestId: id,
        userId,
        model,
        createdAt: new Date(),
        requestParams,
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
      requestParams,
      userId,
      model,
      status: 'success',
      inferenceParameters: parameters,
      inferenceInfo: info,
    });
  } catch (error) {
    await supabaseAdmin
      .from('a1_request')
      .update({
        id,
        status: 'server_error',
        updatedAt: new Date()
      })
      .eq('id', id)
    log_event({ event: 'executorError', data: error.message })
    console.error('🔴 got error: ', error);
    res.status(500).send(error);
  }
});
const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const axios = require('axios');
// const Redis = require("ioredis");
const { v4: uuid } = require('uuid');
const Redis = require("@upstash/redis")

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
    const parsedInfo = JSON.parse(info)
    const imgIds = images.map((image, index) => `${uuid()}`)
    if (images.length > 0) {
      const promiseArr = images.map((image, index) => {
        console.log(imgIds[index])
        return s3Client.send(new PutObjectCommand({
          Bucket: "a1-generated",
          Key: `generated/${imgIds[index]}.png`,
          Body: Buffer.from(image, 'base64'),
          ContentType: 'image/png'
        }))
      })
      const responses = await Promise.all(promiseArr)
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
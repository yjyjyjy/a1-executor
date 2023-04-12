const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const axios = require('axios');
// const { uuid } = require('uuidv4');
const { v4: uuid } = require('uuid');

functions.http('a1execprodv2', async (req, res) => {
  console.log(`🪵:a1execprodv2:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const s3Client = new S3Client({ region: "us-east-1" });
  const { id, endpoint, sd_model_checkpoint, params } = req.body
  const log_event = ({ event, data }) => {
    axios.post('https://a1execprodlogs-ake5r4huta-ue.a.run.app', { id, event, ts: new Date(), data })
  }
  log_event({ event: 'executorStarted' })
  try {
    // 🌳 update option (model) to worker load balancer
    // const entryPointUrl = 'http://Platf-ecs00-Y9KFXQP2BFXS-18468705.us-east-1.elb.amazonaws.com'
    const entryPointUrl = sd_model_checkpoint === 'lofi_V2pre'
      ? 'http://lofi-loadbalancer-2039171330.us-east-1.elb.amazonaws.com'
      : 'http://a1-loadbalancer-1850067276.us-east-1.elb.amazonaws.com'
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
        createdAt: new Date(),
        requestParams: params
      })))
    console.log('✅', 'image gen success')
    log_event({ event: 'executorRequestSupabaseUpdated' })
    // 🌳🔴 call moderation

    // axios.post(`https://a1moderation-ake5r4huta-ue.a.run.app`, { id })

    // 🌳 return response (not used except for debugging)
    res.send({
      requestId: id,
      endpoint,
      sd_model_checkpoint,
      params,
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
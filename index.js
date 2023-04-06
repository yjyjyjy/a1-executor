const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const axios = require('axios');

functions.http('a1execprod', async (req, res) => {
  console.log(`🪵:a1execprod:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const s3Client = new S3Client({ region: "us-east-1" });
  const { id, endpoint, sd_model_checkpoint, params } = req.body
  try {
    const entryPointUrl = 'http://Platf-ecs00-Y9KFXQP2BFXS-18468705.us-east-1.elb.amazonaws.com'
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
        supabase.from('request_logs').insert({
          id: id,
          event: 'executorOptionUpdateFailed',
          ts: new Date(),
          data: { error: error.message }
        })
        throw error
      }
    }
    let startTime = new Date()
    await updateOption()
    let endTime = new Date()
    const timeSpentChangeModel = endTime - startTime
    const url = `${entryPointUrl}${endpoint}` // endpoint: `/sdapi/v1/txt2img`,
    console.log('url: ', url)
    const response = await axios.post(url, params)
    console.log('🪵', 'Object.keys(response.data)', Object.keys(response.data))
    const { images, parameters, info } = response.data
    if (images.length > 0) {
      const response = await s3Client.send(new PutObjectCommand({
        Bucket: "a1-generated",
        Key: `generated/${id}.png`,
        Body: Buffer.from(images[0], 'base64'),
        ContentType: 'image/png'
      }))
      if (response.$metadata.httpStatusCode !== 200) {
        throw new Error('S3 upload failed')
      }
      console.log('🪵', 'S3 upload success')
    }
    let { error } = await supabase
      .from('a1_request')
      .update({
        id,
        status: 'success',
        inferenceParameters: parameters,
        inferenceInfo: info,
        // resultData: images,
        completedAt: new Date(),
        timeSpentChangeModel
      })
      .eq('id', id)
    if (error) { throw error }
    console.log('✅', 'image gen success')
    // call moderation
    axios.post(`https://a1moderation-ake5r4huta-ue.a.run.app`, { id })

    res.status(200).send({
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
    await supabase.from('request_logs').insert({
      id: id,
      event: 'executorError',
      ts: new Date(),
      data: { error: error.message }
    })
    console.error('🔴', "got error: ", error);
    res.status(500).send(error);
  }
});
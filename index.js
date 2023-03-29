const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
// const { EC2Client, StartInstancesCommand, DescribeInstanceStatusCommand } = require("@aws-sdk/client-ec2");

const axios = require('axios');

functions.http('a1execprod', async (req, res) => {
  console.log(`🪵:a1execprod:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const s3Client = new S3Client({ region: "us-east-1" });
  const { id, endpoint, sd_model_checkpoint, params } = req.body
  try {
    // const instanceIp = '44.204.101.147'
    const entryPointUrl = 'http://a1-loadbalancer-1850067276.us-east-1.elb.amazonaws.com'

    const updateOption = async () => {
      // const configApiUrl = `http://${instanceIp}:7860/sdapi/v1/options`
      const configApiUrl = `${entryPointUrl}/sdapi/v1/options`
      console.log('configApiUrl: ', configApiUrl)
      const resp = await axios.post(
        configApiUrl,
        { sd_model_checkpoint },
        { headers: { 'Content-Type': 'application/json' } }
      )
      console.log(`🪵:a1execprod:updateOption:${resp.status}`)
      if (resp.status !== 200) {
        throw new Error('inference node is down')
      }
    }
    await updateOption()

    const url = `${entryPointUrl}${endpoint}` // endpoint: `/sdapi/v1/txt2img`,
    console.log('url: ', url)
    const response = await axios.post(url, params)
    console.log('🪵', 'Object.keys(response.data)', Object.keys(response.data))
    const { images, parameters, info } = response.data
    console.log(id)
    console.log(typeof images)
    console.log(images.length)
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
        updatedAt: new Date()
      })
      .eq('id', id)
    if (error) { throw error }
    console.log('✅', 'image gen success')
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
    console.error("got error: ", error);
    res.status(500).send(error);
  }
});



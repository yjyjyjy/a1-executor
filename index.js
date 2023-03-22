const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
// const { EC2Client, StartInstancesCommand, DescribeInstanceStatusCommand } = require("@aws-sdk/client-ec2");

const axios = require('axios');

functions.http('sdrequest', async (req, res) => {
  console.log(`🪵:sdrequest:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const s3Client = new S3Client({ region: "us-east-1" });
  const { id, userId, endpoint, sd_model_checkpoint, params } = req.body
  try {
    // const inferenceInstanceId = 'i-0586907b3f7ee3d10'
    // let instanceStartCalled = false
    // let ip = ''
    // let sd_model_checkpoint
    const instanceIp = '44.204.101.147'

    const updateOption = async () => {

      // let { data: selectedInstances, error: selectInstanceError } = await supabase
      //   .from('instance')
      //   .select('id, status, ip')
      //   .eq('id', inferenceInstanceId)
      // if (selectInstanceError) { throw selectInstanceError }
      // if (selectedInstances.length === 1 && selectedInstances[0].status === 'running' && selectedInstances[0].ip) {
      //   console.log('status:', status)
      //   if (status === 'running') {
      //     console.log('🔴 selectedInstances: ', selectedInstances)
      //     ip = selectedInstances[0].ip
      //     return
      //   }
      //   await supabase
      //     .from('instance')
      //     .update({ status })
      //     .eq('id', inferenceInstanceId)
      // }
      const configApiUrl = `http://${instanceIp}:7860/sdapi/v1/options`
      console.log('configApiUrl: ', configApiUrl)
      const resp = await axios.post(
        configApiUrl,
        { sd_model_checkpoint },
        { headers: { 'Content-Type': 'application/json' } }
      )
      console.log(`🪵:sdrequest:updateOption:${resp.status}`)
      if (resp.status !== 200) {
        return res.status(500).json({ message: 'inference node is down' })
      }
      // console.log(options)
      // if (options.sd_model_checkpoint) {
      //   const model = options.sd_model_checkpoint.split('.ckpt')[0].split('.safetensors')[0]
      //   if (mode) {
      //     sd_model_checkpoint = model
      //   }
      // }



      // const { InstanceStatuses } = await ec2Client.send(new DescribeInstanceStatusCommand({
      //   InstanceIds: [inferenceInstanceId]
      // }))
      // const status = InstanceStatuses[0]?.InstanceState?.Name
      // if (status === 'stopping') {
      //   setTimeout(await checkInferenceEC2Status(), 5000)
      // }


      // console.log('selectedInstances: ', JSON.stringify(selectedInstances))
      // if (!instanceStartCalled) {
      //   const { StartingInstances } = await ec2Client.send(new StartInstancesCommand({
      //     "InstanceIds": [inferenceInstanceId]
      //   }))
      //   console.log(`StartingInstances ${JSON.stringify(StartingInstances)}`)
      //   instanceStartCalled = true
      // }
      // setTimeout(await checkInferenceEC2Status(), 5000)
    }
    await updateOption()

    const url = `http://${instanceIp}:7860${endpoint}`
    console.log('url: ', url)
    const response = await axios.post(url, params)
    console.log('🔴🔴🔴🔴🔴', Object.keys(response.data))
    const { images, parameters, info } = response.data
    console.log(id)
    console.log(typeof images)
    console.log(images.length)
    if (images.length > 0) {
      const response = await s3Client.send(new PutObjectCommand({
        Bucket: "a1-generated",
        Key: `${userId}/${id}.png`,
        Body: Buffer.from(images[0], 'base64'),
        ContentType: 'image/png'
      }))
      console.log('🔴🔴aws s3 response🔴🔴', JSON.stringify(response))
    }
    if (response.metadata.httpStatusCode !== 200) {
      throw new Error('S3 upload failed')
    }
    let { error } = await supabase
      .from('a1_request')
      .update({
        id,
        status: 'completed',
        inferenceParameters: parameters,
        inferenceInfo: info,
        // resultData: images,
        updatedAt: new Date()
      })
      .eq('id', id)

    if (error) { throw error }
    res.status(200).send({ message: 'success' });
  } catch (error) {
    //return an error
    console.error("got error: ", error);
    res.status(500).send(error);
  }
});



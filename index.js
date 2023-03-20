const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const { EC2Client, StartInstancesCommand, DescribeInstanceStatusCommand } = require("@aws-sdk/client-ec2");

const axios = require('axios');

functions.http('sdrequest', async (req, res) => {
  console.log(`🪵:sdrequest:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const ec2Client = new EC2Client({ region: "us-east-1" });
  const { id, endpoint, params } = req.body

  // endpoint
  // bring up the inference machine

  try {
    const inferenceInstanceId = 'i-0af68d8e2fcef2b02'
    let instanceStartCalled = false
    let ip = ''

    const checkInferenceEC2Status = async () => {
      const { InstanceStatuses } = await ec2Client.send(new DescribeInstanceStatusCommand({
        InstanceIds: [inferenceInstanceId]
      }))
      const status = InstanceStatuses[0]?.InstanceState?.Name
      if (status === 'stopping') {
        setTimeout(await checkInferenceEC2Status(), 5000)
      }

      let { data: selectedInstances, error: selectInstanceError } = await supabase
        .from('instance')
        .select('id, status, ip')
        .eq('id', inferenceInstanceId)
      if (selectInstanceError) { throw selectInstanceError }
      if (selectedInstances.length === 1 && selectedInstances[0].status === 'running' && selectedInstances[0].ip) {
        console.log('status:', status)
        if (status === 'running') {
          console.log('🔴 selectedInstances: ', selectedInstances)
          ip = selectedInstances[0].ip
          return
        }
        await supabase
          .from('instance')
          .update({ status })
          .eq('id', inferenceInstanceId)
      }

      console.log('selectedInstances: ', JSON.stringify(selectedInstances))
      if (!instanceStartCalled) {
        const { StartingInstances } = await ec2Client.send(new StartInstancesCommand({
          "InstanceIds": [inferenceInstanceId]
        }))
        console.log(`StartingInstances ${JSON.stringify(StartingInstances)}`)
        instanceStartCalled = true
      }
      setTimeout(await checkInferenceEC2Status(), 5000)
    }
    await checkInferenceEC2Status()

    const url = `http://${ip}:7860/sdapi/v1/txt2img`
    console.log('url: ', url)
    const response = await axios.post(url, params)
    console.log('🔴🔴🔴🔴🔴', Object.keys(response.data))
    const { images, parameters, info } = response.data
    let { error } = await supabase
      .from('a1_request')
      .update({
        status: 'completed',
        inferenceParameters: parameters,
        inferenceInfo: info,
        resultData: images,
        updatedAt: new Date()
      })
      .eq('id', id)
    if (error) { throw error }
    res.status(200).send({ message: 'success' });
  } catch (error) {
    //return an error
    console.log("got error: ", error);
    res.status(500).send(error);
  }
});



const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient;
const axios = require('axios');

functions.http('sdrequest', async (req, res) => {
  console.log(`🪵:sdrequest:${JSON.stringify(req.body)}`)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const { id, url, params } = req.body
  try {
    const response = await axios.post(url, params)
    console.log('🔴🔴🔴🔴🔴', Object.keys(response.data))
    const { images, parameters, info } = response.data
    let { error } = await supabase
      .from('a1_request')
      .update({
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



const functions = require('@google-cloud/functions-framework');
const createClient = require('@supabase/supabase-js').createClient

functions.http('sdrequest', async (req, res) => {
  console.log('YOoooooo!')
  console.log('🔴', process.env)
  // const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)


  try {
    if (req.body.temp < 100) {
      res.status(200).send("Temperature OK");
    } else {
      res.status(200).send(process.env);
    }
  } catch (error) {
    //return an error
    console.log("got error: ", error);
    res.status(500).send(error);
  }
});



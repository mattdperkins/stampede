exports.credentials = {
  bitstamp: {
    client_id: "your_bitstamp_login_id",  // Your bitstamp ID (number)
    key: "your_bitstamp_API_key",         // Bitstamp API key, need to generate through their UI
    secret: "your_bitstamp_API_secret"    // Bitstamp API secret
  },
  btcchina: {
    key: "btcchina-key",
    secret: "btcchina-secret",
    client_id: "btcchina-username" 
  }
}

// Change me upon deployment
exports.session_secret = 'randomStringForSessionSecret' 

exports.exchange = {
  selected: "bitstamp",                   // Selected exchange
  currency: "usd"                         // Currency on exchange (WARNING, lowercase, 'cny' in case of btcchina)
}

exports.owner = {
  email: "your_email_address"     // Email address where notifications about sales, purchases and errors will be sent
}

exports.email = {
  presence: "application_from_email(gmail)",          // Gmail account email address the app will use to send email notifications from
  password: "application_from_email_password(gmail)"  // Password for the account (make sure this password is permanent)
}

exports.trading = {
  base_currency_per_deal: 20,           // Base $ per starting deal / trade / hand
  maximum_investment: 0,                // Maximum total $ allowed to invest in BTC
  bid_alignment: 0.1,                   // Bid align for competitive edge when placing bids 
                                        // EXAMPLE: BTC price is $600, to buy, we would place order at: 600 / 0.999 = 600.6
  max_number_of_deals_per_trader: 3,    // How many deals can a trader manage
  momentum_time_span: 5*60*1000,        // Set momentum time span to x minutes (change the first number, that is minutes)
  greed: 5,                          // What upside does the trader look for?
                                        // EXAMPLE: If bought 1 BTC for $600, with greed at 0.05, it will sell for 600*(1+0.05) = 630
  impatience: 10,                     // When do I buy, for how much over current middle 
                                        // (Example: Middle is at $600, hight at $700, impatience 0.2, I would buy at (700 - 600)*0.2 + 600 = 620
  altitude_drop: 1                      // (%) If I buy at the lowest price, only buy at a price X % lower then the lowest
}

exports.strategy = {
  momentum_trading: true,   // Purchases will be happening on momentum up trend
  trailing_stop: true,      // Sales will happen only after trailing stop is reached
  bell_bottom: true,        // Purchases will be sized up going down the price per trader
  combined_selling: true,   // Sell the highest and lowest priced BTC combined
  dynamic_multiplier: true, // Calculate deal multiplication per altitude drop and current high
  dynamic_drop: true        // Dynamically increase altitude drop per fibonacci series
}

// Google authentication keys
exports.auth = {
  client_id: "googleOauthClientId",
  client_secret: "googleOauthClientSecret"
}

// Port the app will be running at
exports.port = 3111
// Port for redis store
exports.redis_port = 6379

// Size limit to displayed usd values graph
exports.sheet_size_limit = 300

// Hosts, also used for authentication realm
exports.hosts = {
  development: "http://localhost", 
  production: "production_url"
}

exports.logging = {
  decisions: false      // Whether to log decisions into common log 
                        // Recommended to disable when running with simulator
}

// Path for storing stampede generated datasets
exports.data_set_directory = "/var/www/stampede/data/"

// Email addresses of ppl allowed to access this app (needs to be google authenticable)
exports.allowed_user_emails = ["email@address.com", "email2@address.com"] 


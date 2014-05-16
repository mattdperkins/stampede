var config = require("./../plugins/config"),
    common = require("./../plugins/common"),
    async = require("async"),
    db = require("redis").createClient(config.redis_port || 6379),
    email = require("./../plugins/email"),

    // All traders will be loaded into this object
    live_traders = {},

    // Trading performance timers initialization for benchmarking
    perf_timers = {},

    // For communication to client
    controller = require("./../routes/controller"),

    // Load Market and Walled models to initialize instances below
    Market = require("./market"),
    Wallet = require("./wallet"),

    /*
     *
     *
     *  Initialize market and wallet instances
     *
     *
     *
     */

    market = new Market(), 
    wallet = new Wallet(), 

    // Additional shared variables

    trader_count,                                 // Current trader count
    sheets = [],                                  // Current USD value history list
    error_email_sent,                             // Indicate if email for certain error has already been sent
    trader_main_list = "stampede_traders",        // Main repository in redis for keeping list of traders
    stampede_value_sheet = "stampede_value",      // Repository unsorted list for USD value history
    cycle_counter = 0,                            // For simulation purposes so that notification is only emitted
    broadcast_time,                               // Will compute leftover on this
    series_simulation = false,                            // Disables broadcast later, (when series of data are simulated)
    cycle_sell_decisions = [],
    cycle_buy_decisions = [],
    currency_key = config.exchange.currency+"_available",

    /*
     *
     * Constants for trading
     *
     *
     *
     */
    
    MAX_SUM_INVESTMENT,     // Allowed max sum of investment
    MAX_PER_DEAL,           // Allowed investment per trader's deal
    MAX_DEALS_HELD,         // Number of trader deals
    INITIAL_GREED,          // Greed (.05 means trader looks for 5% upside) XXX: As of now, this is calculated based on current market shift (difference btw low and high)
    BID_ALIGN,              // Align bid before buying to allow competitive price
    IMPATIENCE,             // Where do I buy up from middle
    ALTITUDE_DROP,          // Defined lower price percentage to buy at

    /*
     *
     * Trading strategies
     *
     *
     *
     */    

    MOMENTUM_ENABLED,       // Whether purchases will be happening on momentum up trend
    TRAILING_STOP_ENABLED,  // Whether sales will happen only after trailing stop is reached
    BELL_BOTTOM_ENABLED,    // Whether purchases will be sized up going down the price per trader
    COMBINED_SELLING,       // Whether to sell highest and lowest priced BTC combined

    /*
     *
     * Logging options
     *
     *
     *
     */    
    DECISION_LOGGING,



    // Dirty variable declaration end
    variable_declaration_ender;


function initializeConfig() {

  // Trading configuration variables
  MAX_SUM_INVESTMENT = config.trading.maximum_investment;
  MAX_PER_DEAL = config.trading.maximum_currency_per_deal;         
  MAX_DEALS_HELD = config.trading.max_number_of_deals_per_trader;
  INITIAL_GREED = config.trading.greed;   
  BID_ALIGN = config.trading.bid_alignment;
  IMPATIENCE = config.trading.impatience;
  ALTITUDE_DROP = config.trading.altitude_drop;

  // Strategies now
  MOMENTUM_ENABLED = config.strategy.momentum_trading;
  TRAILING_STOP_ENABLED = config.strategy.trailing_stop;
  BELL_BOTTOM_ENABLED = config.strategy.bell_bottom;
  COMBINED_SELLING = config.strategy.combined_selling;

  // Logging options load
  DECISION_LOGGING = (config.logging || {}).decisions || false;

}


/*
 *
 *
 *  Trader prototype
 *
 *
 *
 */

function Trader(name) {
  
  this.name = name;
  /*
   *
   *
   *  Redis repos and scopes
   *
   *
   *
   */

  this.id_counter = "stampede_trader_number";
  this.trader_prefix = "trader_";
  this.book_prefix = "book_for_";
  this.main_list = trader_main_list;
  this.deals = [];

}


/*
 *
 *
 *  Trader engine definitions
 *
 *
 *
 */

Trader.prototype = {

  // Record and initialize(add to shared live_traders) new trader

  create: function(callback) {
    var me = this;
    db.incr(me.id_counter, function(error, number) {
      me.name = me.trader_prefix + number;
      db.sadd(me.main_list, me.name, function(error, response) {
        me.record = {
          book: me.book_prefix + me.name,
          deals: MAX_DEALS_HELD
        };
        me.deals = [];
        live_traders[me.name] = me;
        db.hmset(me.name, me.record, callback);
        me.record.current_investment = 0;
        me.record.current_deals = 0;
      });
    });
  },
  
  // Stop and remove trader

  remove: function(done) {
    var me = live_traders[this.name],
        my_book = me.record.book;
    me.checkRecord(function() {
      db.srem(me.main_list, me.name, function(error, response) {
        db.del(my_book);
        db.del(me.name, function() {
          delete live_traders[me.name];
          wakeAll(done);
        });
      });
    });
  },
  
  // Loads trader's deals
  checkInventory: function(callback) {
    var me = this;
    me.deals = me.deals || [];
    if (
      me.record &&
      me.record.book
    ) {
      db.smembers(me.record.book, function(error, deals) {
        me.deals = deals || [];
        me.deals.forEach(function(deal, index) {
          me.deals[index] = parseDeal(deal);
        });
        if (callback) callback(error, me.record);
      });
    }
    else if (callback) callback(null, null) ;
  },

  // Loads trader record from repository and then loads trader's deals
  checkRecord: function(callback) {
    var trader = this;
    db.hgetall(trader.name, function(error, my_record) {
      trader.record = my_record;
      trader.checkInventory(callback);
    });
  },


  /*
   *
   * Awaken trader = Load all associations
   *
   *
   *
   *
   */
  
  wake: function(callback) {
    var me = this;
    live_traders[me.name] = me;
    me.checkRecord(callback);
  },
  
  /*
   *
   * When trader is awake
   *
   *
   *
   *
   */
   
  // decide if buying, define candidate deal

  isBuying: function() {

    var me = this,
        decision = false,

        // Get the lowest price of deal bought
        deals = me.deals,
        borders = deals.extremesByKey("buy_price"),
        lowest_buy_price = borders.min.buy_price || 0,
        currency_buy_amount = 
          BELL_BOTTOM_ENABLED ? (
            ((deals.length / MAX_DEALS_HELD) + 1) * MAX_PER_DEAL
          ) : MAX_PER_DEAL,

        // Check if trader has available spot for another deal
        has_free_hands = MAX_DEALS_HELD > me.deals.length,
        
        // Available resources, compare investment 
        // and current available in wallet
        available_resources = 

          // Check if I am not running over allowed investment amount
          (wallet.current.investment < MAX_SUM_INVESTMENT) &&

          // This serves to knock out trading 
          // (if I assign less investment than deal)
          (MAX_SUM_INVESTMENT > currency_buy_amount) &&

          // Check if I have enough fiat to buy
          (wallet.current[currency_key] > currency_buy_amount),

        // Calculate trader bid 
        // (aligned by bid alignment to make us competitive when bidding)
        trader_bid = (market.current.last / BID_ALIGN),

        // Check if aligned bid is below threshold 
        // (which combines the impatience variable)
        bid_below_threshold = trader_bid < market.current.threshold,

        // Define altitude drop
        altitude_drop_perc = ALTITUDE_DROP || 0,

        // Projected buy price (dependent on existing lowest buy price, 
        // otherwise trader bid is selected)
        projected_buy_price = (
          lowest_buy_price > 0
        ) ? (lowest_buy_price * (1 - (altitude_drop_perc / 100))) : trader_bid,

        // If existing deals, 
        // check that I am buying for price lower than the lowest existing
        bid_below_lowest = (
          lowest_buy_price > 0
        ) ? (trader_bid < projected_buy_price) : bid_below_threshold,

        // Check if current market span (high - low / last) is favorable 
        // and wider than fee
        potential_better_than_fee = (
            market.current.shift_span / 2
          ) > (
            2 * (wallet.current.fee / 100)
          ),

        // What is the current market acceleration
        current_market_greed = (market.current.shift_span / 2),

        // What potential is the trader looking at
        trader_greed = INITIAL_GREED + ((wallet.current.fee || 0.5) / (2*100)),

        // If current wallet cool combined with greed exceeds 1
        weighted_heat = wallet.current.cool + trader_greed,
        potential_better_than_heat = (weighted_heat > 1),

        // Check if market has positive momentum
        market_momentum_significant = (
          market.current.momentum_record_healthy &&
          market.current.momentum_average > 0
        );
    
    // Decision process takes place on whether to buy
    if (
      has_free_hands &&
      available_resources &&
      (!MOMENTUM_ENABLED || market_momentum_significant) &&
      bid_below_threshold &&
      bid_below_lowest &&
      potential_better_than_fee &&
      potential_better_than_heat
    ) decision = true;
    
    if (decision && DECISION_LOGGING) console.log(
      "*** Buying deal? ***",
      "\n|- Has hands available (..., me.deals.length):", 
        has_free_hands, me.deals.length,
      "\n|- Available resources (..., wallet.current.investment):", 
        available_resources, wallet.current.investment,
      "\n|- Bid is below threshold (..., market.current.last, market.current.middle):", 
        bid_below_threshold, market.current.last.toFixed(2), 
        market.current.middle.toFixed(2),
      "\n|- Bid is lowest among deals (..., lowest_buy_price):", 
        bid_below_lowest, lowest_buy_price.toFixed(2),
      "\n|- Projected profit is better than fee (..., market.current.shift_span):", 
        potential_better_than_fee, market.current.shift_span.toFixed(2),
      "\n|- Projected profit better than heat (..., wallet.current.cool, weighted_heat):", 
        potential_better_than_heat, wallet.current.cool.toFixed(2), 
        weighted_heat,
      "\n|- Market momentum is significant (..., momentum_indicator, momentum_healthy)", 
        market_momentum_significant, 
        market.current.momentum_indicator, 
        market.current.momentum_record_healthy,
      "\n_BUY__ Decision:", decision ? "BUYING" : "HOLDING",
      "\n******"
    );
    
    //console.log("Market from isBuying:", market.current);

    var structured_decision = {
      trader: 
        "(" + me.name.split("_")[1] + 
        ") buy (" + (projected_buy_price).toFixed(2) + ")",
      free_hands: has_free_hands,
      resources: available_resources,
      threshold: bid_below_threshold,
      lowest: bid_below_lowest,
      potential: potential_better_than_heat,
      momentum: (!MOMENTUM_ENABLED || market_momentum_significant),
      cool: potential_better_than_heat,
      decision: decision
    };

    //console.log("structured_decision:", structured_decision);
    cycle_buy_decisions.push(structured_decision);

    return decision;
  },

  isSelling: function(combined_deal) {
    var me = this,
        deals = me.deals,
        // Get min and max deal from all, initialize a combined deal for further calc
        borders = deals.extremesByKey("buy_price"),
        // Initialize resulting decision
        decision = false,
        // Deal independent calculations
        current_market_greed = (market.current.shift_span / 2),
        // Calculate for comparison on deal
        current_sale_price = (market.current.last * BID_ALIGN),
        // Calculate trader greed
        trader_greed = INITIAL_GREED + ((wallet.current.fee || 0.5) / (2*100)),
        // If wallet is ready
        weighted_heat = wallet.current.cool + trader_greed,
        // Check if wallet is ready
        potential_better_than_heat = (weighted_heat > 1),
        // Check if market has negative momentum
        market_momentum_low = (
          market.current.momentum_record_healthy &&
          market.current.momentum_average <= 0
        );


    combined_deal.currency_amount = 0;
    combined_deal.amount = 0;
    combined_deal.names = [];

    // Calculate weighted price for deals from extremes (lowes and highest)
    // Only if COMBINED SELLING is enabled:
    // We will sell them at once if the -
    // Weighted average + fees and profit is below market last

    (COMBINED_SELLING ? ["min", "max"] : ["min"]).forEach(function(extreme) {
      var current = borders[extreme];
      if (
        current && 
        combined_deal.names.indexOf(current.name) === -1
      ) {
        combined_deal.currency_amount += (current.buy_price * current.amount);
        combined_deal.max_currency_amount += 
          (
            current.max_price ? current.max_price : current.buy_price
          ) * current.amount;
        combined_deal.amount += current.amount;
        combined_deal.names.push(current.name);
      }
      else if (!config.simulation) {
        console.log(
          "sellingCheck | deal combination skip | current, " + 
          "combined_deal,",
          current, combined_deal
        );
      }
    });
    
    if (combined_deal.amount > 0) {
      combined_deal.buy_price = 
        combined_deal.currency_amount / combined_deal.amount;
      combined_deal.max_price = 
        combined_deal.max_currency_amount / combined_deal.amount;
      combined_deal.would_sell_at = 
        (combined_deal.buy_price) * (1 + trader_greed + (1 - BID_ALIGN));
    }
    
    /* 

      Deal dependent calculations

    */

    // Stop price is the buy price reduced by half of greed
    combined_deal.stop_price = 
      (combined_deal.max_price) * (1 - (trader_greed / 2));

    // Create structured decision object (rendered on client), 
    // used for consolidated decision check
    var structured_decision = {
      trader: 
        "("+me.name.split("_")[1] + 
        ") sell (" + (combined_deal.would_sell_at || 0).toFixed(2) + ")",
      would_sell_price: (combined_deal.would_sell_at < current_sale_price),
      cool: potential_better_than_heat
    };

    // If trailing stop enabled, add to structured decision
    // Set the stop deal as deal to sell if not selling combined deal
    // And if trailing stop was hit
    if (TRAILING_STOP_ENABLED) {
      structured_decision.trailing_stop = (
        combined_deal.stop_price >= current_sale_price &&
        (2 * MAX_PER_DEAL) > wallet.current[currency_key] &&
        combined_deal.names.length > 1
      );

      combined_deal.trailing_stop = structured_decision.trailing_stop;
    }

    structured_decision.managed = (
      combined_deal.amount <= wallet.current.btc_balance
    );

    // Check trailing stop, if enabled affect decision
    structured_decision.decision = (
      (
        (!TRAILING_STOP_ENABLED && structured_decision.would_sell_price) ||
        structured_decision.trailing_stop
      ) &&
      structured_decision.managed &&
      structured_decision.cool
    );

    // Add the decision to array which will be rendered on client
    cycle_sell_decisions.push(structured_decision);

    // Log the success!
    if (
      structured_decision.decision && 
      DECISION_LOGGING
    ) console.log(
      "||| trader | sellingCheck | " + 
      "isSelling? | structured_decision:", 
      structured_decision
    );

    // Check all outstanding factors and make final decision
    var decision = (
      structured_decision.decision &&
      combined_deal.names.length > 0
    );

    if (decision && DECISION_LOGGING) console.log(
      "*** Selling deal? ***",
      "\n|- amount is managed (amount):", 
        (combined_deal.amount <= wallet.current.btc_balance), 
        combined_deal.amount,
      "\n|- potential_better_than_heat:", potential_better_than_heat,
      "\n_SALE_ Decision:", decision ? "SELLING" : "HOLDING",
      "\nDeal evaluated details:", combined_deal
    );

    return decision; 
  },
  
  decide: function(done) {
    var me = this;
    if (
      market.current &&
      market.current.last > 5
    ) {
      var purchase_deal = {},
          sale_deal = {};

      if (
        me.isBuying()
      ) {
        me.buy(purchase_deal, done);
      }
      else if (
        me.isSelling(sale_deal)
      ) {
        me.sell(sale_deal, done);
      }
      else done();
    }
    else {
      console.log("("+me.name+"): Market is not ready for my decisions yet.");
      done();
    }
  },
  
  buy: function(deal, done) {
    var me = this,
        currency_buy_amount = 
          BELL_BOTTOM_ENABLED ? (
            ((me.deals.length / MAX_DEALS_HELD) + 1
          ) * MAX_PER_DEAL) : MAX_PER_DEAL;

    deal.buy_price = (market.current.last / BID_ALIGN);

    deal.amount = (currency_buy_amount / deal.buy_price);
    deal.sell_price = (
      deal.buy_price * (1 + INITIAL_GREED + (wallet.current.fee / 100))
    );
    deal.heat = INITIAL_GREED;
    wallet.current.cool -= market.current.shift_span;
    //wallet.current.investment += deal.buy_price;
    if (!series_simulation) controller.notifyClient({
      message: 
        "Decided to BUY " + deal.amount.toFixed(5) + 
        "BTC for " + config.exchange.currency.toUpperCase() + 
        " " + currency_buy_amount.toFixed(2) + 
        " at " + config.exchange.currency.toUpperCase() + 
        " " + deal.buy_price.toFixed(2)+" per BTC.", 
      permanent: true
    });
    
    controller.buy(
      deal.amount.toFixed(7), 
      deal.buy_price.toFixed(2), 
    function(error, order) {
      if (DECISION_LOGGING) console.log(
        "trader | buy | order, error:", order, error
      );
      if (
        order &&
        order.id
      ) {
        deal.order_id = order.id;
        me.recordDeal(deal, done);
        if (!config.simulation) email.send({
          to: config.owner.email,
          subject: "Stampede - Buying: "+deal.amount.toFixed(7)+"BTC",
          template: "purchase.jade",
          data: {
            deal: deal,
            market: market,
            wallet: wallet
          }
        }, function(success) {
          console.log("Email sending success?:", success);
          if (error_email_sent) error_email_sent = null;
        });        
      }
      else {
        if (!config.simulation) email.send({
          to: config.owner.email,
          subject: "Stampede: Error BUYING deal through bitstamp API",
          template: "error.jade",
          data: {error:error}
        }, function(success) {
          console.log("ERROR Email sending success?:", success);
          error_email_sent = true;
        });
        done();
      }
    });
  },

  sell: function(deal, done) {
    var me = this;
    deal.heat = deal.buy_price / MAX_SUM_INVESTMENT;
    deal.aligned_sell_price = (market.current.last * BID_ALIGN).toFixed(2);
    
    // Align current cool to avoid all sell / buy
    wallet.current.cool -= market.current.shift_span;
    
    if (!series_simulation) controller.notifyClient({
      message: 
        (deal.trailing_stop ? "(STOP)" : "(REG)") +
        "Decided to SELL " + deal.amount.toFixed(5) + 
        "BTC for "+config.exchange.currency.toUpperCase() + 
        " "+((market.current.last * BID_ALIGN)*deal.amount).toFixed(2) + 
        " at "+config.exchange.currency.toUpperCase()+deal.aligned_sell_price + 
        " per BTC.", 
      permanent: true
    });

    controller.sell(
      deal.amount.toFixed(7), 
      deal.aligned_sell_price, 
    function(error, order) {
      if (DECISION_LOGGING) console.log(
        "EXCHANGE: Response after attempt to sell | error, order:", 
        error, order
      );
      if (
        order && 
        order.id
      ) {
        // Create asynchronous queue that will 
        // purge sold deals from redis and live traders
        async.each(deal.names, function(deal_name, internal_callback) {
          me.removeDeal(deal_name, internal_callback);
        }, done);

        if (!config.simulation) email.send({
          subject: "Stampede - Selling: "+deal.name,
          template: "sale.jade",
          data: {
            deal: deal,
            market: market,
            wallet: wallet
          }
        }, function(success) {
          console.log("Email sending success?:", success);
          if (error_email_sent) error_email_sent = null;
        });
      }
      else {
        deal.order_id = "freeze";
        if (!config.simulation) email.send({
          subject: "Stampede: Error SELLING deal through bitstamp API",
          template: "error.jade",
          data: {error:error}
        }, function(success) {
          console.log("ERROR Email sending success?:", success);
          error_email_sent = true;
        });   
        done();
      }
    });
    
  },
  
  recordDeal: function(deal, callback) {
    var me = this;
    me.deals.push(deal);
    var deal_string = stringDeal(deal);
    if (!config.simulation) {
      db.sadd(me.record.book, deal.name, callback);
    }
    else callback();
  },
  
  removeDeal: function(deal_name, callback) {
    var me = this,
        deal_position = me.deals.lookupIndex("name", deal_name);

    //console.log("removeDeal | me.deals, deal_name:", me.deals, deal_name);
    if (deal_position > -1) {
      me.deals.splice(deal_position, 1);
      if (!config.simulation) {
        db.srem(me.record.book, deal_name, callback);
      }
      else callback();
    }
    else {
      console.log(
        "!!! trader | removeDeal | Unable to find deal for removal | deal_name", 
        deal_name
      );
      callback("Problems finding deal.", null);
    }
  },

  highlightExtremeDeals: function() {
    var me = this,
        all_deals = me.deals,
        borders = all_deals.extremesByKey("buy_price");
    if (
      borders.min && 
      borders.max &&
      borders.min.name !== borders.max.name
    ) all_deals.forEach(function(deal) {
      deal.is_highest = (deal.name === borders.max.name);    
      deal.is_lowest = (deal.name === borders.min.name);
    });
  },

  addCurrentMaximumPrice: function() {
    var me = this,
        current_market = market.current;

    if (current_market && me.deals.length) {
      me.deals.forEach(function(deal) {
        deal.max_price = (
          deal.max_price > current_market.last
        ) ? deal.max_price : current_market.last;
      });
    }
  } 
};

// Create a hash by deal name to lookup deals and their traders
function findByDeal(deal_name) {
  var deal_sheet = {};

  for (var trader_name in live_traders) {
    var trader_deals = live_traders[trader_name].deals;
    if (
      trader_deals && 
      trader_deals.length > 0
    ) {
      trader_deals.forEach(function(deal) {
        deal_sheet[deal.name] = trader_name;
      });
    }
  }

  return live_traders[deal_sheet[deal_name]];

}



function getAllDeals() {
  var all_deals = [];

  for (var trader_name in live_traders) {
    var trader_deals = live_traders[trader_name].deals;
    if (trader_deals && trader_deals.length > 0) {
      all_deals = all_deals.concat(trader_deals);
    }
    else {
      //console.log("getAllDeals | "+trader_name+" has no deals.");
    }
  }
  return all_deals;
}

//"deal|1.1|332|338"
function parseDeal(deal) {
  var original = ""+deal,
      deal_arrayed = deal.split("|"),
      objectified_deal = {
        name: original,
        amount: parseFloat(deal_arrayed[1]),
        buy_price: parseFloat(deal_arrayed[2]),
        sell_price: parseFloat(deal_arrayed[3]),
        order_id: deal_arrayed[4]
      };
  return objectified_deal;
}

//"deal|1.1|332|338"
function stringDeal(deal) {
  deal.name = 
    "deal|" + deal.amount + 
    "|" + deal.buy_price + 
    "|" + deal.sell_price + 
    "|" + (deal.order_id || "freeze");
  return deal.name;
}

function cycle(done) {
  var cycle_start_timer = Date.now();
  cycle_counter++;
  broadcast_time = (
    !config.simulation || 
    cycle_counter % 10000 === 0
  ) && !series_simulation;
  if (!config.simulation) console.log("Cycle initiated.");
  cycle_buy_decisions = [];
  cycle_sell_decisions = [];
  var actions = [
    checkWallet,
    checkMarket
  ];

  // Initialize market and wallet data into global var, exposed on top
  async.series(actions, function(errors, results) {

    // Export current market and wallet data
    exports.current_market = market.current;
    exports.current_wallet = wallet.current;

    // Final callback returning default market.current
    if (done) done(null, market.current);
    perf_timers.cycle = 
      (perf_timers.cycle || 0) + (Date.now() - cycle_start_timer);
    // Update client on performed decisions
    if (broadcast_time) {
      controller.refreshDecisions({
        buy_decisions: cycle_buy_decisions,
        sell_decisions: cycle_sell_decisions
      });
    }
    if (cycle_counter % 10000 === 0) logPerformance();
  });
}

function checkMarket(done) {
  var market_start_timer = Date.now();
  market.check(function(error, market_current) {
    var stop_simulation = (config.simulation && error && error.stop);
    // Check if traders are initialized
    if (
      live_traders && 
      !stop_simulation
    ) {
      if (broadcast_time) controller.refreshTraders(live_traders);
      var i = 0, 
          new_deal_count = 0,
          btc_to_distribute = 
            wallet.current.btc_available - wallet.current.btc_amount_managed;

      market.current.threshold = 
        IMPATIENCE * 
        (
          market.current.high - market.current.middle
        ) + 
        market.current.middle;
      wallet.current.currency_value = 
        (wallet.current.btc_balance || 0) * 
        (market.current.last || 0) + 
        (wallet.current[config.exchange.currency+"_balance"] || 0);
      perf_timers.market = 
        (perf_timers.market || 0) + (Date.now() - market_start_timer);
      var decisions_start_timer = Date.now();

      var trader_queue = async.queue(function(trader_name, internal_callback) {
        var trader = live_traders[trader_name];
        // Add attributes to lowest and highest deals to show up in view
        trader.highlightExtremeDeals();
        // Add highest deal price for each deal
        trader.addCurrentMaximumPrice();
        // Decide if buying or selling
        trader.decide(internal_callback);
      }, 1);


      if (broadcast_time) controller.refreshWallet(wallet.current);
      for (var trader_name in live_traders) {
        if (live_traders.hasOwnProperty(trader_name)) {
          trader_queue.push(trader_name);
        }
      }

      trader_queue.drain = function() {
        perf_timers.decisions = 
          (perf_timers.decisions || 0) + (Date.now() - decisions_start_timer);
        var cool_up = INITIAL_GREED,
            next_check = (
              config.simulation ? 0 : ( 
                (
                  process.env.NODE_ENV || 
                  "development"
                ) === "development" ? 10000 : 4000) + (Math.random()*3000)
            );
        wallet.current.cool = (
          wallet.current.cool < 1 && 
          cool_up < (1 - wallet.current.cool)
        ) ? wallet.current.cool + cool_up : 1;

        if (config.simulation) {
          cycle();
        }
        else {
          console.log(
            "... Cycle(wallet, market) CHECK again in:", 
            (next_check / 1000).toFixed(2), 
            "seconds. - "+(new Date())+"."
          );
          refreshSheets();
          if (market.timer) clearTimeout(market.timer);
          market.timer = setTimeout(cycle, next_check);
        }
        if (done) done(null, market.current);
      };

      // refresh client side on current market data 
      // & current wallet data
      if (broadcast_time) controller.refreshMarket(market.current);
    }
    else {
      console.log("No traders present or market simulation stopped.");
      if (done) done(null, market.current);
    }
  });  
}

function pullValueSheet(callback) {
  callback(sheets);
}

function checkSheets(done) {
  console.log("* Checking history sheets.");
  
  var timestamp = Date.now();

  db.zrange(
    [stampede_value_sheet, 0, -1, "WITHSCORES"], 
  function(error, sheet_records) {
    var step = Math.round(sheet_records.length / 100);
    sheet_records.forEach(function(record, index) {
      var sheets_index = Math.floor(index / 2);
      if (!sheets[sheets_index]) {
        // This is a value
        sheets[sheets_index] = {
          value: parseFloat(record)
        };
      }
      else {
        // This is a timestamp
        sheets[sheets_index].time = parseInt(record);
      }
    });
    controller.drawSheets(sheets, "full");
    done(error, sheets);
  });
}

function refreshSheets() {
  var time_stamp = Date.now(),
      sheet_size_limit = 500,
      current_currency_value = wallet.current.currency_value;

  if (current_currency_value > 10 && !config.simulation) {
    db.zadd(
      stampede_value_sheet, 
      time_stamp, 
      current_currency_value.toString(), function(error, response) {
      
      var new_value = {
        time: time_stamp, 
        value: current_currency_value
      };

      sheets.push(new_value);
      if (broadcast_time) controller.drawSheets(new_value, "incremental");

      // Now, let's check if we should remove any points
      db.zcard(stampede_value_sheet, function(error, sheets_size) {
        if (sheets_size && parseInt(sheets_size) > sheet_size_limit) {
          var cutoff_size = sheets_size - sheet_size_limit;
          db.zremrangebyrank(
            stampede_value_sheet, 0, cutoff_size, 
          function(error, response) {
            sheets.splice(0, cutoff_size);
            console.log("Removed ", (cutoff_size), "points from sheets.");
          });
        }
      });
    });
  }
}


function checkWallet(done) {
  // Initialize into global var, exposed on top
  var wallet_start_timer = Date.now();
  if (!config.simulation) console.log("* Checking wallet.");
  wallet.check(live_traders, function() {
    if (
      !series_simulation && 
      broadcast_time
    ) controller.refreshShares(wallet.shares);
    wallet.assignAvailableResources(MAX_SUM_INVESTMENT);
    perf_timers.wallet = 
      (perf_timers.wallet || 0) + (Date.now() - wallet_start_timer);
    if (done) done(null, wallet.current);
  });
}

function updateConfig(new_config) {
  if (configValid(new_config)) {
    for (var attribute in new_config) {
      config.trading[attribute] = 
        new_config[attribute] || config.trading[attribute];
    }

    initializeConfig();
    
    //controller.refreshTradingConfig(config.trading);

    console.log(
      "trader | updateConfig | comparison:",
      "\n: MAX_SUM_INVESTMENT / config.trading.maximum_investment:", 
        MAX_SUM_INVESTMENT, config.trading.maximum_investment,
      "\n: INITIAL_GREED / config.trading.greed:", 
        INITIAL_GREED, config.trading.greed
    );
  }
  else {
    if (!series_simulation) controller.notifyClient({
      message: "Unable to update config, values are invalid."
    });
  }
}


function updateStrategy(new_config) {
  for (var attribute in new_config) {
    config.strategy[attribute] = new_config[attribute];
  }

  initializeConfig();

  console.log(
    "updateStrategy | Configuration initialized | config.strategy:", 
    config.strategy
  );
}

function resetConfig() {
  var reset_config = require("./../plugins/config");
  console.log("resetConfig | reset_config.trading:", reset_config.trading);
  config = reset_config;
  initializeConfig();
  //controller.refreshTradingConfig(config.trading);
}


// Trading config validation!

function configValid(trading_config) {
  return (
    !isNaN(trading_config.maximum_currency_per_deal) &&
    trading_config.maximum_currency_per_deal > 1 &&
    !isNaN(trading_config.maximum_investment) &&
    trading_config.maximum_investment >= 0 &&
    !isNaN(trading_config.bid_alignment) &&
    trading_config.bid_alignment < 1 &&
    trading_config.bid_alignment > 0.9 &&
    !isNaN(trading_config.max_number_of_deals_per_trader) &&
    trading_config.max_number_of_deals_per_trader > 0
  );
}

function checkTraders(trader_list, done) {
  var q = async.queue(function(trader_name, internal_callback) {
    var trader = new Trader(trader_name);
    trader.wake(function(error, trader_record) {
      //console.log("Trader wakeup: ", trader_name)
      internal_callback(error);
    });
  }, 2);
  q.drain = function() {
    console.log("Queue drained in checkTraders.");
    controller.refreshTraders(live_traders);
    if (done) done(null, live_traders);
  };
  trader_list.forEach(function(trader_name) {
    q.push(trader_name);
  });
}

function wakeAll(done) {
  initializeConfig();
  db.smembers(trader_main_list, function(error, trader_list) {
    console.log("wakeAll, Waking ("+trader_list.length+") traders...");
    trader_count = trader_list.length;
    if (
      trader_list &&
      trader_list.length > 0
    ) {
      async.series([
        function(internal_callback) {
          checkTraders(trader_list, internal_callback);
        },
        cycle,
        checkSheets
      ], function(errors, results) {
        if (errors) {
          console.log("Problems loading traders, market or wallet:", errors);
          done();
        }
        else {
          if (done) done();
        }
      });
    }
    else {
      if (done) done(live_traders);
    }
  });
}

function viewTraders(done) {
  db.smembers(trader_main_list, function(error, trader_list) {
    console.log("viewTraders, Viewing ("+trader_list.length+") traders...");
    trader_count = trader_list.length;
    if (
      trader_list &&
      trader_list.length > 0
    ) {
      checkTraders(trader_list, done);
    }
  });
}

function prepareForSimulation(series) {
  //initializeConfig();
  stopAll();
  config.simulation = true;
  market.simulation = true;
  wallet.simulation = true;
  if (series) {
    series_simulation = true;
    config.series_simulation =
      market.series_simulation =
      wallet.series_simulation =
      true;
  }
  db.del(stampede_value_sheet);
}

function removeAllDeals() {
  for (var name in live_traders) {
    var trader = live_traders[name];
    var trader_deals_copy = trader.deals.slice(0);
    trader_deals_copy.forEach(function(deal) {
      var deal_name = deal.name;
      trader.removeDeal(deal_name, function() {
        console.log("removeAllDeals | deal:", deal_name);
      });
    });
  }
}

function addShare(holder, investment) {
  if (
    wallet &&
    holder.length > 1 &&
    investment > 0
  ) wallet.addShare(holder, investment, function(error, response) {
    console.log(
      "Added share (" + config.exchange.currency + investment + 
      ") for " + holder + ". (..., error, response)", error, response
    );
  });
}

function stopAll(done) {
  // clearTimeout(timer);
  wallet = new Wallet();
  market = new Market();
  sheets = [];
  live_traders = {};
  if (done) done();
}

function refreshAll() {
  controller.refreshTraders(live_traders);
  controller.refreshMarket(market.current);
  controller.refreshWallet(wallet.current);
  controller.refreshShares(wallet.shares);
  console.log("trader | refreshAll | sheets.length :", sheets.length);
  setTimeout(controller.drawSheets(sheets, "full"), 5000);
}

function logPerformance() {
  console.log(
    "--- PERFORMANCE LOGGING ("+cycle_counter+") ---\n",
    "| Full cycle:", 
      ((perf_timers.cycle || 0) / cycle_counter).toFixed(2), "ms/cycle average",
    "| Market check:", 
      ((perf_timers.market || 0) / cycle_counter).toFixed(2), "ms/cycle",
    "| Wallet check:", 
      ((perf_timers.wallet || 0) / cycle_counter).toFixed(2), "ms/cycle",
    "| Decisions check:", 
      ((perf_timers.decisions || 0) / cycle_counter).toFixed(2), "ms/cycle"
  );
}

exports.stopAll = stopAll;
exports.wakeAll = wakeAll;
exports.instance = Trader;
exports.refreshAll = refreshAll;
exports.pullValueSheet = pullValueSheet;
exports.addShare = addShare;
exports.updateConfig = updateConfig;
exports.updateStrategy = updateStrategy;
exports.resetConfig = resetConfig;

// Open variables (simulation required)
exports.live_traders = live_traders;
exports.config = config;
exports.prepareForSimulation = prepareForSimulation;
exports.removeAllDeals = removeAllDeals;
exports.viewTraders = viewTraders;

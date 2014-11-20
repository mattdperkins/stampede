module.exports = function(STAMPEDE) {
  Array.prototype.lookup = function(key, value) {
    var i=0, result
    while (i < this.length && !result) {
      var current_object = this[i]
      if (current_object[key] === value) result = current_object
      i++
    }
    return result
  }

  Array.prototype.lookupIndex = function(key, value) {
    var i=0, result
    while (i < this.length && !result) {
      var current_object = this[i]
      if (current_object[key] === value) result = i
      i++
    }
    return result
  }

  // Extract values of keys in array of hashes
  function extract(arr, key) {
    var res = []
    arr.forEach(function(member) {
      var value = member[key]
      if (value) {
        res.push(value)
      }
    })
    return res
  }

  String.prototype.upperCaseFirst = function() {
    var string = this
    return string.charAt(0).toUpperCase() + string.slice(1)
  }

  Array.prototype.averageByKey = function(key) {
    var array = this,
        sum = 0,
        length = (array || []).length
    if (length > 0) {
      for (var i = 0; i < length; i++) {
        var member = array[i]
        if (
          member[key] && 
          !isNaN(member[key])
        ) sum += member[key]
      }
      return (sum / length)
    }
    else {
      return null
    }  
  }


  Array.prototype.extremesByKey = function(key) {
    var copy = this.slice(0)
    copy.sort(function(a, b) {
      return (a[key] - b[key])
    })
    return {
      min: copy[0] || {},
      max: copy[copy.length - 1] || {}
    }
  }

  // Standard email validation
  function validateEmail(email) { 
    var re = /^(([^<>()[\]\\.,:\s@\"]+(\.[^<>()[\]\\.,:\s@\"]+)*)|(".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
    return re.test(email)
  }

  // for consistent time labeling down to second grain
  function timeLabel() {
    var t = new Date(),
        h = ("0" + t.getHours()).slice(-2),
        m = ("0" + t.getMinutes()).slice(-2),
        s = ("0" + t.getSeconds()).slice(-2),
        y = t.getFullYear(),
        mn = ("0" + (t.getMonth() + 1)).slice(-2),
        d = ("0" + t.getDate()).slice(-2),
        l = y+"-"+mn+"-"+d+"-"+h+":"+m+":"+s
    return l
  }

  function reassignProperties(source_hash, target_hash) {
    for (var property in source_hash) {
      if (source_hash.hasOwnProperty(property)) {
        target_hash[property] = 
          source_hash[property]
      }
    }
  }

  function cumulate(base, length, ratio) {
    var result = base
    for (var multiplier = 0; multiplier < (length - 1); multiplier++) {
      result *= ratio
    }
    return result
  }

  function sum(array) {
    var result = 0
    if (array && array.length) {
      array.forEach(function(member) {
        result += member
      })
    }
    return result
  }


  function getAltitudeLevels(min, max, drop) {
    var levels = [],
        price_cursor = max

    if (drop) {
      while (price_cursor > min) {
        levels.push(price_cursor)
        price_cursor = price_cursor / (1 + (drop / 100))
      }
    }
    return levels
  }

  function getCurrentRatio(max_sum, altitude_levels, max_ratio, base) {
    var min_ratio = 1.1,
        cur_ratio = min_ratio,
        sum = 0,
        step = 0.1,
        result = {
          // Assign default(max) ratio in case no result fits
          ratio: min_ratio,
          // Assign default sum for projection in case I do not have any result
          projected_sum: getSeriesTotal(min_ratio)
        }
    while (max_ratio > cur_ratio) {
      var cur_sum = getSeriesTotal(cur_ratio)
      if (cur_sum < max_sum && cur_sum > result.projected_sum) {
        result.ratio = cur_ratio
        result.projected_sum = cur_sum
      }
      cur_ratio += step
    }

    return result.ratio

    function getSeriesTotal(ratio) {
      var len = altitude_levels.length,
          total = base
      while (len--) {
        var amount = base * Math.pow(ratio, len)
        total += amount
      }
      return total
    }
  }

  function capitalizeFirst(str) {
    return str.upperCaseFirst()
  }

  function standardizeString(str) {
    var input_valid_string = (str && typeof(str) === "string")
    return (
      capitalizeFirst((input_valid_string ? str : "").replace(/_/gi, " "))
    )
  }

  function shortenIfLong(str, limit) {
    return (str.length > limit ? (str.substr(0, limit) + "..." ) : str)
  }

  var time = {}
  time.second = 1000
  time.minute = time.second * 60
  time.hour = time.minute * 60
  time.day = time.hour * 24
  time.week = time.day * 7
  time.format = 'MMMM Do YYYY, HH:mm:ss'
  time.days = [
    { name: "Monday" },
    { name: "Tuesday" },
    { name: "Wednesday" },
    { name: "Thursday" },
    { name: "Friday" },
    { name: "Saturday" },
    { name: "Sunday" }
  ]

  // Quick custom time formatter with moment module
  function timeFormat(time_incoming) {
    return STAMPEDE.moment(time_incoming).format(time.format)
  }


  var formatter = {
        capitalizeFirst: capitalizeFirst,
        standardize: standardizeString,
        shortenIfLong: shortenIfLong,
        tFormat: timeFormat
      }

  return {
    validateEmail: validateEmail,
    timeLabel: timeLabel,
    formatter: formatter,
    reassignProperties: reassignProperties,
    cumulate: cumulate,
    sum: sum,
    extract: extract,
    getAltitudeLevels: getAltitudeLevels,
    getCurrentRatio: getCurrentRatio
  }

}
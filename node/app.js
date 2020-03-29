const http = require('http')
const URL = require('url')
const qs = require('querystring')
const mysql = require('mysql')

const hostname = '127.0.0.1'
const port = 2200

const mysqlConnectionSettings = {
    host : 'localhost',
    user : '',             // Your database user name goes here
    password : '',         // The password for your your database user goes here 
    database : 'sakila'    // The name of the database you want to connect to
}

// Set up an HTTP server using node's built-in http module
// that allows us to listen for requests at a specific host and port
http.createServer(handleRequest)
    .listen(port, hostname, () => {
        console.log(`Server running at http://${hostname}:${port}`)
    })

// This function will get called for every request received by the server
// we initialized above (note the reference to handleRequest in the code above)
function handleRequest(req, res) {

    const url = URL.parse(`http://${hostname}:${port}` + req.url)

    // In order to interact with the database, we establish a connection with it
    // using the mysql connector module installed via `npm install mysql`
    const mysqlConnection = mysql.createConnection(mysqlConnectionSettings)

    // Set some default response attributes
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')

    // Deal with CORS requests (since we're using non-standard ports,
    // the browser will make any XMLHttpRequests CORS requests).
    // Here, if the CORS origin header is set to a localhost value
    // just include that value in the Access-Control-Allow-Origin header
    // in the response
    if ( req.headers.origin && (req.headers.origin.includes("localhost") || req.headers.origin.includes("127.0.0.1")) ) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    }

    // This 'if' block does what most frameworks do under a module called 'routing'
    // It determines which functions to call depending on which 'route' (or url path) was requested
    if ( req.method === 'GET' ) {
        if ( url.pathname === '/' ) {
            respondJSON(res, "Home")
        } else if ( url.pathname === '/actors' ) {
            const params = new URLSearchParams(url.query)
            respondWithActors(mysqlConnection, res, params.get('lname'), params.get('fname'))
        } else if ( url.pathname === '/films' ) {
            const params = new URLSearchParams(url.query)
            respondWithFilms(mysqlConnection, res, params.get('title'))
        } else {
            respond404(res)
        }
    } else if ( req.method === 'POST' ) {
        if ( url.pathname === '/actor' ) {
            
            // For posts, we need to obtain the post data.
            // The node http module allows us to do this using the 
            // .on("data", ..) and .on("end", ..) event handlers
            let body = ""
            req.on("data", chunk =>  body += chunk)
            req.on("end", () => {
                let post = qs.parse(body)

                // Once we have the data we can now do stuff with it
                addActorWithFilms(mysqlConnection, res, post)
            })
        } else {
            respond404()
        }
    } else {
        respond404()
    }

}

// Send back a 404 response to the client by setting the http status to 404
function respond404(res) {
    res.statusCode = 404
    respondJSON(res, "Not found")
}

function respondJSON(res, json) {
    // We wrap all JSON responses in a root object to prevent JSON Hijacking
    res.end(JSON.stringify({ results: json }))
}

function respondWithActors(cnx, res, lastNameFilter="", firstNameFilter="") {

    let sql = "SELECT * FROM actor"

    let conditions = []
    if ( lastNameFilter ) {
        // Here we set an SQL statement with a ? placeholder for an operand
        condition = "last_name LIKE ?"

        // The mysql module provides the format method (among others) which 
        // ensures that values put into placeholders are escaped properly
        condition = mysql.format(condition, [ lastNameFilter + '%' ])

        conditions.push(condition)
    }

    if ( firstNameFilter ) {
        // Here we set an SQL statement with a ? placeholder for an operand
        condition = "first_name LIKE ?"

        // The mysql module provides the format method (among others) which 
        // ensures that values put into placeholders are escaped properly
        condition = mysql.format(condition, [ firstNameFilter + '%' ])

        conditions.push(condition)
    }

    if ( conditions.length ) {
        sql += " WHERE " + conditions.join(" AND ")
    }


    // START BAD CODE...
    //
    // NEVER DO THIS!!!
    // Constructing a query by directly concatenating unescaped values from an outside source causes SQL injection vulnerabilities!
    // If the code below is used instead of the prepared statement above, it is possible for a malicious user
    // to obtain ANY data from your database using this endpoint using a carefully constructed URL.  For example,
    // this URL (still using the /actor endpoint) yields each CUSTOMER's contact info.  Whoops...
    //
    // http://localhost:2200/actors?lname='union select '', concat(first_name, ' ', last_name), concat(address, ', ', city, ', ', country, ', ', postal_code, ', ', phone), '' from customer join address using(address_id) join city using(city_id) join country using(country_id);--%20
    //
    // Now imagine the terrible consequences if in addition to an SQL injection vulnerability you also stored your passwords
    // in plain text.  Spare yourself the shame and use prepared statements any time you are incorporating values from outside
    // sources into your queries.
    //
    //
    // sql = "SELECT * FROM actor WHERE last_name LIKE '" + lastNameFilter + "%'"
    //
    //
    // ... END BAD CODE

    cnx.query(sql, function(err, results) {

        if ( err ) { 
            throw err 
        }

        //cnx.end()
        respondJSON(res, results)
    })
}

function respondWithFilms(cnx, res, titleFilter="") {

    let sql
    if ( titleFilter ) {
        // List films that START with the filter first, then films that contain it afterward
        sql = "SELECT * FROM film WHERE title LIKE ? UNION SELECT * FROM film WHERE title LIKE ?"
        sql = mysql.format(sql, [titleFilter + '%', '%' + titleFilter + '%'])
    } else {
        sql = "SELECT * FROM film"
    }

    cnx.query(sql, (err, results) => {
        if ( err ) { throw err }

        respondJSON(res, results)
    })
}

// In this function we are given in postData one new actor's first and last name, plus
// an array of film ids to which that actor must be associated.
// In order to prevent insertion of only part of this data if things go Terribly Wrong
// we will use a transaction so that ALL our database-altering queries will apply their
// effect in a single operation, or none will apply at all
function addActorWithFilms(cnx, res, postData) {

    // Open a transaction...
    cnx.beginTransaction( err => {
        if ( err ) { throw err }

        // First insert the new actor
        const sql = "INSERT INTO actor (first_name, last_name) VALUES (?, ?)"
        cnx.query(sql, [ postData.first_name, postData.last_name ], (err, results) => {

            // If there was a problem, roll back the transaction and quit
            if ( err ) { return cnx.rollback(() => { throw err }) }

            // The mysql module helpfully gives us the id of the newly inserted object
            const actorId = results.insertId

            // Now let's associate the selected films with this new actor
            // First, we'll make a list of the VALUE rows we are going to need to insert
            // NOTE that we escape the filmIds because they are coming from an outside source
            // but we don't need to escape actorId because that comes from our app
            const rows = postData.film_id.map( filmId => "(" + cnx.escape(filmId) + "," + actorId + ")" )

            const filmSQL = "INSERT INTO film_actor (film_id, actor_id) VALUES " + rows.join(",")

            // Now try associating the new actor id with the given film ids
            cnx.query(filmSQL, (err) => {
                
                // Again, if there was a problem, roll back the transaction and quit
                if ( err ) { return cnx.rollback(() => { throw err }) }

                // If we get here, everything went well and we can commit the transaction
                cnx.commit( err => { 

                    // It's possible that the commit fails, in which case we still need to roll back
                    if ( err ) { return cnx.rollback(() => { throw err }) }

                    // At last, we can respond to the user that we have completed the addition
                    respondJSON(res, { actor_id: actorId, first_name: postData.first_name, last_name: postData.last_name })

                })
            })


        })
    })
}

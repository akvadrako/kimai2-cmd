/* -------------------------------------------------------------------------- */
/*                                   Modules                                  */
/* -------------------------------------------------------------------------- */

//builtin
const path = require('path');
const fs = require('fs');

const platform = process.platform
const appdata = process.env.appdata

//request
const request = require('request');

//ui
const inquirer = require('inquirer');
const fuzzy = require('fuzzy');
const program = require('commander');

// ini
const ini = require('ini');

//moment
const moment = require('moment');

//reading version number from package.json
var pjson = require('./package.json');

/* -------------------------------------------------------------------------- */
/*                                  Functions                                 */
/* -------------------------------------------------------------------------- */

/**
 * Calls the kimai API
 * 
 * @param {string} httpMethod Http method: 'GET', 'POST', 'PATCH'...
 * @param {string} kimaiMethod Endpoint to call on the kimai API: timesheet, activities, timesheets/123/stop
 * @param {object} serversettings Serversettings section read from ini. Only serversettings, not the full settings!
 * @param {object} options All of them are optional: 
 * options.qs querystring
 * options.reqbody request body
 * @returns {object} The response body as an object
 * 
 */
function callKimaiApi(httpMethod, kimaiMethod, serversettings, options = false) {
    //default options to false:
    const qs = options.qs || false
    const reqbody = options.reqbody || false

    if (program.verbose) {
        console.log("calling kimai:", httpMethod, kimaiMethod, serversettings)
    }

    return new Promise((resolve, reject) => {
        const options = {
            url: sanitizeServerUrl(serversettings.kimaiurl) + '/api/' + kimaiMethod,
            headers: {
                'X-AUTH-USER': serversettings.username,
                'X-AUTH-TOKEN': serversettings.password,
            },
            method: httpMethod
        }

        if (qs) {
            options.qs = qs
        }
        if (reqbody) {
            options.body = JSON.stringify(reqbody)
            options.headers['Content-Type'] = 'application/json'
        }

        if (program.verbose) {
            console.log("request options:", options)
        }

        request(options, (error, response, body) => {
            if (error) {
                reject(error)
            }

            let jsonarr = JSON.parse(response.body)

            if (program.verbose) {
                console.log("Response body:", jsonarr)
            }

            if (jsonarr.message) {
                console.log('Server error message:')
                console.log(jsonarr.code)
                console.log(jsonarr.message)
                reject(jsonarr.message)
            }

            resolve(jsonarr)
        })
    })
}

/**
 * Interactive ui: displays the main menu
 * 
 * @param {object} settings The full settings object read from the ini
 */
function uiMainMenu(settings) {
    console.log()
    inquirer
        .prompt([
            {
                type: 'list',
                name: 'mainmenu',
                message: 'Select command',
                pageSize: process.stdout.rows - 1,
                choices:
                    [
                        { name: 'Restart recent measurement', value: 'restart' },
                        { name: 'Start new measurement', value: 'start' },
                        { name: 'Stop all active measurements', value: 'stop-all' },
                        { name: 'Stop an active measurement', value: 'stop' },
                        new inquirer.Separator(),
                        { name: 'List active measurements', value: 'list-active' },
                        { name: 'List recent measurements', value: 'list-recent' },
                        { name: 'List projects', value: 'list-projects' },
                        { name: 'List activities', value: 'list-activities' },
                        new inquirer.Separator(),
                        { name: 'Exit', value: 'exit' }
                    ]
            }
        ])
        .then(answers => {
            if (program.verbose) {
                console.log('selected answer: ' + answers.mainmenu)
            }
            switch (answers.mainmenu) {
                case 'restart':
                    kimaiList(settings, 'timesheets/recent', false)
                        .then(res => {
                            return uiSelectMeasurement(res[1])
                        }).then(startId => {
                            return kimaiRestart(settings, startId)
                        })
                        .then(res => uiMainMenu(res[0]))
                    break;
                case 'start':
                    uiKimaiStart(settings)
                        .then(_ => uiMainMenu(settings))
                    break;
                case 'stop-all':
                    kimaiStop(settings, false)
                        .then(_ => uiMainMenu(settings))
                    break;
                case 'stop':
                    kimaiList(settings, 'timesheets/active', false)
                        .then(res => {
                            return uiSelectMeasurement(res[1])
                        }).then(stopId => {
                            return kimaiStop(settings, stopId)
                        })
                        .then(res => uiMainMenu(res[0]))
                    break;

                case 'list-active':
                    kimaiList(settings, 'timesheets/active', true)
                        .then(res => uiMainMenu(res[0]))
                    break;
                case 'list-recent':
                    kimaiList(settings, 'timesheets/recent', true)
                        .then(res => uiMainMenu(res[0]))
                    break;
                case 'list-projects':
                    kimaiList(settings, 'projects', true)
                        .then(res => uiMainMenu(res[0]))
                    break;
                case 'list-activities':
                    kimaiList(settings, 'activities', true)
                        .then(res => uiMainMenu(res[0]))
                    break;
                default:
                    break;
            }
        })
}

/**
 * Restarts a measurement
 * 
 * @param {object} settings All settings read from ini
 * @param {string} id The id of the measurement to restart
 * 
 */
function kimaiRestart(settings, id) {
    return new Promise((resolve, reject) => {
        callKimaiApi('PATCH', 'timesheets/' + id + '/restart', settings.serversettings)
            .then(res => {
                resolve([settings, res])
            })
    })
}

/**
 * Interactive ui: select a project and activity and starts it
 * 
 * @param {object} settings All settings read from ini
 */
function uiKimaiStart(settings) {
    return new Promise((resolve, reject) => {
        const selected = {}
        kimaiList(settings, 'projects', false)
            .then(res => {
                // console.log(res[1])
                return uiAutocompleteSelect(res[1], 'Select project')
            })
            .then(res => {
                // console.log(res)
                selected.projectId = res.id
                return kimaiList(settings, 'activities', false, { filter: { project: res.id } })
            })
            .then(res => {
                return uiAutocompleteSelect(res[1], 'Select activity')
            })
            .then(res => {
                selected.activityId = res.id
                return kimaiStart(settings, selected.projectId, selected.activityId)
            })
            .then(_ => {
                resolve()
            })
    })
}

/**
 * Start a timer on the server
 * 
 * @param {object} settings 
 * @param {string} project Id of project
 * @param {string} activity Id of activity
 */
function kimaiStart(settings, project, activity) {
    return new Promise((resolve, reject) => {

        let body = {
            begin: moment().format(),
            project: project,
            activity: activity
        }
        if (program.verbose) {
            console.log("kimaistart calling api:", body)
        }

        callKimaiApi('POST', 'timesheets', settings.serversettings, { reqbody: body })
            .then(res => {
                console.log('Started: ' + res.id)
                resolve()
            })
    })

}

/**
 * Find id of project or activity by name
 * 
 * @param {object} settings 
 * @param {string} name The name to search for
 * @param {string} endpoint 
 */
function findId(settings, name, endpoint) {
    return new Promise((resolve, reject) => {
        kimaiList(settings, endpoint, false)
            .then(res => {
                const list = res[1]
                for (let i = 0; i < list.length; i++) {
                    const element = list[i];
                    if (element.name.toLowerCase() == name.toLowerCase()) {
                        resolve(element.id)
                    }
                }
                reject()
            })
    })
}

/**
 * Stops one or all current measurements. If id is empty it stops all, if given only selected
 * 
 * @param {object} settings 
 * @param {string} id 
 */
function kimaiStop(settings, id = false) {
    return new Promise((resolve, reject) => {
        if (id) {
            callKimaiApi('PATCH', 'timesheets/' + id + '/stop', settings.serversettings)
                .then(res => {
                    resolve([settings, res])
                })
        } else {
            kimaiList(settings, 'timesheets/active', false)
                .then(res => {
                    const jsonList = res[1]
                    return callKimaiStop(settings, jsonList)
                    //callKimaiStop(settings, jsonList)
                })
                .then(_ => {
                    resolve()
                })
        }
    })
}

/**
 * Supplementary function for stopping multiple running measurements
 * 
 * @param {*} settings All settings
 * @param {*} jsonList As the output of kimaiList()
 * @param {*} i Counter, do not use!
 */
function callKimaiStop(settings, jsonList, i = 0) {
    return new Promise((resolve, reject) => {
        const element = jsonList[i];
        callKimaiApi('PATCH', 'timesheets/' + element.id + '/stop', settings.serversettings)
            .then(jsl => {
                console.log('Stopped: ', jsl.id)
                i++
                if (i < jsonList.length) {
                    callKimaiStop(settings, jsonList, i)
                } else {
                    resolve()
                }
            })
    })
}

/**
 * Calls the api, lists and returns elements
 * 
 * @param {object} settings The full settings object read from the ini
 * @param {string} endpoint The endpoint to call in the api.
 * @param {boolean} print If true, it prints to the terminal
 * @param {object} options Options: 
 * options.filter: filter the query,
 * @returns {array} res[0]: settings, res[1]: list of elements
 */
function kimaiList(settings, endpoint, print = false, options = false) {
    const filter = options.filter || false
    return new Promise((resolve, reject) => {
        callKimaiApi('GET', endpoint, settings.serversettings, { qs: filter })
            .then(jsonList => {
                if (print) {
                    printList(settings, jsonList, endpoint)
                }
                resolve([settings, jsonList])
            })
            .catch(msg => {
                console.log("Error: " + msg)
            })
    })
}


/**
 * Prints list to terminal
 * 
 * @param {object} settings The full settings object read from the ini
 * @param {array} arr Items to list
 * @param {string} endpoint for selecting display layout
 */
function printList(settings, arr, endpoint) {
    if (program.verbose) {
        console.log()
        if (arr.length > 1) {
            console.log(arr.length + ' results:')
        } else if (arr.length == 0) {
            console.log('No results')
        } else {
            console.log('One result:')
        }
    }
    //no result for scripts:
    if (arr.length == 0) {
        if (program.argos) {
            console.log('No active measurements')
        }
        if (program.argosbutton) {
            console.log("Kimai2")
        }
    }
    for (let i = 0; i < arr.length; i++) {
        const element = arr[i];

        if (endpoint == 'projects' || endpoint == 'activities') {
            if (program.verbose) {
                console.log((i + 1) + ':', element.name, '(id:' + element.id + ')')
            } else if (program.id) {
                console.log(element.id + ':', element.name)
            } else {
                console.log(element.name)
            }

        } else { //measurements
            if (program.verbose) {
                if (arr.length > 1) {
                    console.log((i + 1) + ":")
                }
                console.log('   Id: ' + element.id)
                console.log('   Project: ' + element.project.name, '(id:' + element.project.id + ')')
                console.log('   Customer: ' + element.project.customer.name, '(id:' + element.project.customer.id + ')')
                console.log('   Activity: ' + element.activity.name, '(id:' + element.activity.id + ')')
                console.log('   Begin: ' + element.begin)

                if (moment(element.end).isValid()) {
                    //finished measurements:
                    console.log('   Duration: ' + formattedDuration(element.begin, element.end))
                } else {
                    //active measurements:
                    console.log('   Duration: ' + formattedDuration(element.begin))
                }

            } else if (program.id) {
                console.log(element.id + ':', element.project.name, '|', element.activity.name)
            } else if (program.argos) {
                //Argos
                if (endpoint == 'timesheets/recent') {
                    console.log('--' + element.project.name + ',', element.activity.name, '|', 'bash=' + settings.argos_bitbar.kimaipath + ' param1=restart param2=' + element.id + ' terminal=false refresh=true')
                } else if (endpoint == 'timesheets/active') {
                    console.log(formattedDuration(element.begin), element.project.name + ',', element.activity.name, '|', 'bash=' + settings.argos_bitbar.kimaipath + ' param1=stop param2=' + element.id + ' terminal=false refresh=true')
                }
            } else if (program.argosbutton) {
                //Argosbutton
                console.log(formattedDuration(element.begin), element.project.name + ',', element.activity.name, '| length=' + settings.argos_bitbar.buttonlength)
            } else {
                //Regular output
                if (moment(element.end).isValid()) {
                    //finished measurements:
                    console.log(element.project.name, '|', element.activity.name)
                } else {
                    //active measurements:
                    console.log(formattedDuration(element.begin), element.project.name, '|', element.activity.name)
                }
            }
        }
    }
}

/**
 * Returns duration between the two moments or between beginning and now. padded to minimum two digits.
 * 
 * @param {moment} begin beginning moment
 * @param {moment} end optional, end moment
 */
function formattedDuration(begin, end) {
    let momentDuration = moment.duration(moment(end).diff(moment(begin)))

    let hrs = momentDuration.hours()
    let mins = momentDuration.minutes()

    if (hrs.toString().length == 1) {
        hrs = "0" + hrs
    }

    if (mins.toString().length == 1) {
        mins = "0" + mins
    }

    return hrs + ':' + mins
}


/**
 * Interactive ui: select measurement from a list of measurements
 * @param {} thelist 
 */
function uiSelectMeasurement(thelist) {
    return new Promise((resolve, reject) => {
        const choices = []
        for (let i = 0; i < thelist.length; i++) {
            const element = thelist[i];
            choices.push({
                name: element.project.name + " | " + element.activity.name, value: element.id
            })
        }
        inquirer
            .prompt([
                {
                    type: 'list',
                    name: 'selectMeasurement',
                    message: 'Select measurement',
                    pageSize: process.stdout.rows - 1,
                    choices: choices
                }
            ]).then(answers => {
                resolve(answers.selectMeasurement)
            })
    })
}

/**
 * Returns a prompt with autocomplete
 * 
 * @param {array} thelist The list of elements to select from
 * @param {string} message Prompt message
 */
function uiAutocompleteSelect(thelist, message) {
    return new Promise((resolve, reject) => {
        const choices = []
        const names = []
        for (let i = 0; i < thelist.length; i++) {
            const element = thelist[i];
            choices.push({
                name: element.name, id: element.id
            })
            names.push(element.name)
        }
        inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));
        inquirer
            .prompt([
                {
                    type: 'autocomplete',
                    name: 'autoSelect',
                    message: message,
                    pageSize: process.stdout.rows - 2,
                    source: function (answers, input) {
                        input = input || '';
                        return new Promise((resolve, reject) => {
                            var fuzzyResult = fuzzy.filter(input, names);
                            resolve(
                                fuzzyResult.map(function (el) {
                                    return el.original;
                                })
                            )
                        })
                    }
                }
            ]).then(answers => {
                let ind = names.indexOf(answers.autoSelect)
                let selectedChoice = choices[ind]
                // console.log(selectedChoice)
                resolve(selectedChoice)
            })
    })
}


/**
 * Finds settings file path
 * 
 * @returns string: Path to settings.ini
 * @returns false: If no settings found
 */
function iniPath() {
    //different settings.ini path for developement and pkg and windows installer version
    const iniRoot = [
        path.dirname(process.execPath),
        __dirname
    ]

    if (appdata) { iniRoot.push(path.join(appdata, '/kimai2-cmd')) }

    if (program.verbose) {
        console.log('Looking for settings.ini in the following places:')
        console.log(iniRoot)
    }

    for (let i = 0; i < iniRoot.length; i++) {
        const currentIniPath = path.join(iniRoot[i], '/settings.ini')
        if (fs.existsSync(currentIniPath)) {
            return currentIniPath
        }
    }

    // no ini found so:
    return false
}

/**
 * Checks if settings file exists, if not it's asks for settings
 * 
 * @return {object} settings: all settings read from the settings file
 */
function checkSettings() {
    return new Promise((resolve, reject) => {
        const settingsPath = iniPath()
        if (settingsPath) {
            if (program.verbose) console.log("settings.ini found at: ", settingsPath)
            let settings = ini.parse(fs.readFileSync(settingsPath, 'utf-8'))
            resolve(settings)
        } else {
            console.log('Settings.ini not found')
            uiAskForSettings()
                .then(settings => {
                    resolve(settings)
                })

        }
    })
}

/**
 * Interactive ui: asks for settings than saves them
 * 
 */
function uiAskForSettings() {
    return new Promise((resolve, reject) => {
        let questions = [
            {
                type: 'input',
                name: 'kimaiurl',
                message: "Kimai2 url:"
            },
            {
                type: 'input',
                name: 'username',
                message: "Username:"
            },
            {
                type: 'input',
                name: 'password',
                message: "API password:"
            }
        ]

        inquirer
            .prompt(questions)
            .then(answers => {
                let settings = {}
                settings.serversettings = answers
                settings.argos_bitbar = {}

                if (platform == "darwin") {
                    settings.argos_bitbar.kimaipath = process.execPath
                } else {
                    settings.argos_bitbar.kimaipath = "kimai"
                }
                settings.argos_bitbar.buttonlength = 10

                const thePath = iniFullPath()
                if (program.verbose) { console.log('Trying to save settings to: '.thePath) }

                fs.writeFileSync(thePath, ini.stringify(settings))
                console.log('Settings saved to ' + iniPath())
                resolve(settings)
            });
    })
}


/**
 * Returns the ini save path based on os and installation type, creates folder if necessary
 */
function iniFullPath() {
    let installDir = path.dirname(process.execPath).split("\\")

    //I should replace this tererible if to some registry value readin, maybe for uninstaller
    if (platform == 'win32' && installDir[installDir.length - 2] == "Program Files" && installDir[installDir.length - 1] == "kimai2-cmd") {
        if (!fs.existsSync(path.join(appdata, 'kimai2-cmd'))) {
            fs.mkdirSync(path.join(appdata, 'kimai2-cmd'))
        }
        return path.join(appdata, 'kimai2-cmd', 'settings.ini')
    } else {
        return './settings.ini'
    }
}


/**
 * Removes trailing slashes from url
 * 
 * @param {string} kimaiurl Url to sanitize
 */
function sanitizeServerUrl(kimaiurl) {
    return kimaiurl.replace(/\/+$/, "");
}

/* -------------------------------------------------------------------------- */
/*                                  Commander                                 */
/* -------------------------------------------------------------------------- */

program
    .version(pjson.version)
    .description(pjson.description + '. For interactive mode start without any commands. To generate settings file start in interactive mode!')
    .option('-v, --verbose', 'verbose, longer logging', false)
    .option('-i, --id', 'show id of elements when listing', false)
    // .option('-r, --rainmeter', 'generate rainmeter files')
    .option('-b, --argosbutton', 'argos/bitbar button output')
    .option('-a, --argos', 'argos/bitbar output')

program.command('start [project] [activity]')
    .description('start selected project and activity')
    .action(function (project, activity) {
        const selected = {}
        checkSettings()
            .then(settings => {
                findId(settings, project, 'projects')
                    .then(projectid => {
                        selected.projectId = projectid
                        return findId(settings, activity, 'activities')
                    })
                    .then(activityid => {
                        selected.activityId = activityid
                        return kimaiStart(settings, selected.projectId, selected.activityId)
                    })
            })
    })

program.command('restart [id]')
    .description('restart selected measurement')
    .action(function (measurementId) {
        checkSettings()
            .then(settings => {
                kimaiRestart(settings, measurementId)
            })
    })

program.command('stop [id]')
    .description('stop all or selected measurement measurements, [id] is optional')
    .action(function (measurementId) {
        checkSettings()
            .then(settings => {
                kimaiStop(settings, measurementId)
            })
    })

program.command('list-active')
    .description('list active measurements')
    .action(function () {
        checkSettings()
            .then(settings => {
                kimaiList(settings, 'timesheets/active', true)
            })
    })

program.command('list-recent')
    .description('list recent measurements')
    .action(function () {
        checkSettings()
            .then(settings => {
                kimaiList(settings, 'timesheets/recent', true)
            })
    })

program.command('list-projects')
    .description('list all projects')
    .action(function () {
        checkSettings()
            .then(settings => {
                kimaiList(settings, 'projects', true)
            })
    })

program.command('list-activities')
    .description('list all activities')
    .action(function () {
        checkSettings()
            .then(settings => {
                kimaiList(settings, 'activities', true)
            })
    })

program.command('url')
    .description('prints the url of the server')
    .action(function () {
        checkSettings()
            .then(settings => {
                console.log(settings.serversettings.kimaiurl)
            })
    })

// program.command('debug')
//     .description('debug snapshot filesystem. If you see this you are using a developement build')
//     .action(function () {
//         fs.readdir(__dirname, (err, files) => { console.log(files) })
//     })

program.parse(process.argv);


//interactive mode if no option added
if (!program.args.length) {
    checkSettings()
        .then(settings => {
            uiMainMenu(settings)
        })
}

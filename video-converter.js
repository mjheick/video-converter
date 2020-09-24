/* https://nodejs.org/dist/latest-v12.x/docs/api/ */
const fs = require('fs');
const proc = require('child_process');

/* Have some sort of loader for configuration to override internals */
const configuration = {
	"folder_in": "./in",
	"folder_work": "./work",
	"folder_error": "./error",
	"folder_done": "./done",
	"ffmpeg_binary": "/usr/bin/ffmpeg",
	"ffmpeg_parameters": "-vcodec vp8 -acodec libvorbis",
	"ffmpeg_output_extension": "webm",
	"ffmpeg_simultaneous_conversions" : 5,
	"ffprobe_binary": "/usr/bin/ffprobe",
	"ffprobe_parameters": "-v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1",
	"ffprobe_max_video_length": 30,
	"log_folder": null,
	"polling_interval_ms": 5000,
	"done_notify_method": null,
	"done_get_endpoint": null,
	"done_get_var_filename": null,
	"done_post_endpoint": null,
	"done_post_var_filename": null,
	"done_post_var_content": null,
};

/* A list of files we're seeing/converting */
var filelist = [];
var processing = [];

reConfigure();
scheduledStuff();

function scheduledStuff()
{
	reConfigure();
	/* Get a list of all files in folder_in, store them in filelist if they don't already exist. Announce when we add. */
	let dir = fs.opendirSync(configuration.folder_in)
	let dirent = dir.readSync();
	let cullCheck = false;
	while (dirent != null)
	{
		if (dirent.isFile())
		{
			let add_file = true;
			for (let d = 0; d < filelist.length; d++)
			{
				if (filelist[d].name == dirent.name)
				{
					add_file = false;
				}
			}
			if (add_file)
			{
				let obj_fs_statSync = fs.statSync(configuration.folder_in + '/' + dirent.name);
				let fs_size = obj_fs_statSync['size'];
				log(`adding ${dirent.name} (${fs_size} bytes)`);
				let entry = {
					'name': dirent.name,
					'size': fs_size,
					'status': 'new',
					'ffprobe': null
				};
				filelist.push(entry);
			}
		}
		dirent = dir.readSync();
	}
	dir.closeSync();

	/* Go through our array of files and move them through the steps */
	for (let d = 0; d < filelist.length; d++)
	{
		try
		{
			if (filelist[d].status == 'convert')
			{
				let obj_fs_statSync = fs.statSync(configuration.folder_in + '/' + filelist[d].name);
				let fs_size = obj_fs_statSync['size'];
				if (fs_size == filelist[d].size)
				{
					// before we decide to launch, ffprobe this to see if we can use it. if not, cull it
					if (filelist[d].ffprobe == null)
					{
						let video_duration = 0;
						try
						{
							video_duration = proc.execSync(configuration.ffprobe_binary + ' ' + configuration.ffprobe_parameters + ' -i "' + configuration.folder_in + '/' + filelist[d].name + '"', { timeout: 5000});
							video_duration = parseInt(video_duration);
						}
						catch (e)
						{
							video_duration = -1;
						}
						if (video_duration < 0)
						{
							fs.renameSync(configuration.folder_in + '/' + filelist[d].name, configuration.folder_error + '/' + filelist[d].name);
							filelist[d].status = 'cull';
							continue;
						}
						filelist[d].ffprobe = video_duration;
					}
					if (filelist[d].ffprobe > configuration.ffprobe_max_video_length)
					{
						log(`${filelist[d].name} = ${filelist[d].ffprobe}s, greater than ${configuration.ffprobe_max_video_length}s, culling`);
						try /* Move this file to error */
						{
							fs.renameSync(configuration.folder_in + '/' + filelist[d].name, configuration.folder_error + '/' + filelist[d].name);
						} catch (e) { /* Silent */ }
						filelist[d].status = 'cull';
						continue;
					}
					// check to see if we can launch this right now
					if (processing.length < configuration.ffmpeg_simultaneous_conversions)
					{
						log(`processing ${filelist[d].name}`);
						processing.push({'name': filelist[d].name, 'size': filelist[d].size, 'status': filelist[d].status, 'childProcess': null});
						filelist[d].status = 'cull';

						/* Pre-stuff to get the file into a location */
						fs.renameSync(configuration.folder_in + '/' + filelist[d].name, configuration.folder_work + '/' + filelist[d].name);

						let cmd_ffmpeg_exec = configuration.ffmpeg_binary + ' -i "' + configuration.folder_work + '/' + filelist[d].name + '"';
						if (configuration.ffmpeg_parameters !== null)
						{
							cmd_ffmpeg_exec += ' ' + configuration.ffmpeg_parameters + ' ';
						}
						cmd_ffmpeg_exec += ' "' + configuration.folder_work + '/' + filelist[d].name + '.' + configuration.ffmpeg_output_extension + '"';

						log(`executing [${cmd_ffmpeg_exec}]`);
						processing[processing.length - 1].childProcess = proc.exec(cmd_ffmpeg_exec, function (error, stdout, stderr) {
							if (error)
							{
								log(error.stack);
								log('Error code: ' + error.code);
								log('Signal received: ' + error.signal);
							}
							log('Child Process STDOUT: ' + stdout);
							log('Child Process STDERR: ' + stderr);
						});
					}
				}
				else
				{
					log(`moving ${filelist[d].name} to 'check', before=${filelist[d].size}, now=${fs_size}`);
					filelist[d].status = 'check';
					filelist[d].size = fs_size;
					continue;
				}				
			}
			if (filelist[d].status == 'check')
			{
				let obj_fs_statSync = fs.statSync(configuration.folder_in + '/' + filelist[d].name);
				let fs_size = obj_fs_statSync['size'];
				if (fs_size == filelist[d].size)
				{
					filelist[d].status = 'convert';
					log(`moving ${filelist[d].name} from 'check' to 'convert'`);
				}
				else
				{
					log(`keeping ${filelist[d].name} at 'check', before=${filelist[d].size}, now=${fs_size}`);
					filelist[d].size = fs_size;
				}
			}
			if (filelist[d].status == 'new')
			{
				log(`moving ${filelist[d].name} from 'new' to 'check'`);
				filelist[d].status = 'check';
			}
		}
		catch (e)
		{
			/* assume something went wrong with the file, so we need to cull this later on */
			log('catch' + e);
			log(`error with ${filelist[d].name}, culling`);
			filelist[d].status = 'cull';
		}
	}

	/* cull items from filelist */
	/* NOTE: Check for multiple removals */
	do
	{
		cullCheck = false;
		for (let d = 0; d < filelist.length; d++)
		{
			if (filelist[d].status == 'cull')
			{
				filelist.splice(d, 1);
				log(`cullCheck(filelist) index=${d} culled (${filelist.length} items)`);
				cullCheck = true;
				break;
			}
		}
	} while (cullCheck);

	/* Check the processing queue for .working files in the folder_work */
	for (let w = 0; w < processing.length; w++)
	{
		if (processing[w].status == 'working')
		{
			if (processing[w].childProcess.exitCode == null)
			{
				// do nothing. this is acceptable
				log(`processing check=${w}, file ${processing[w].name} is running`);
			}
			else
			{
				log(`moving ${processing[w].name} from 'working' to 'cull', exitCode=${processing[w].childProcess.exitCode}`);
				processing[w].status = 'cull';
				if (processing[w].childProcess.exitCode == 0)
				{
					/* Success */
					fs.renameSync(configuration.folder_work + '/' + processing[w].name  + '.' + configuration.ffmpeg_output_extension, configuration.folder_done + '/' + processing[w].name + '.' + configuration.ffmpeg_output_extension);
					fs.unlinkSync(configuration.folder_work + '/' + processing[w].name);
				}
				else
				{
					/* Error */
					try
					{
						fs.renameSync(configuration.folder_work + '/' + processing[w].name, configuration.folder_error + '/' + processing[w].name);
					} catch (e) { /* Silent */ }
					try
					{
						fs.unlinkSync(configuration.folder_work + '/' + processing[w].name  + '.' + configuration.ffmpeg_output_extension);
					} catch (e) { /* Silent */ }
				}
			}
		}
		if (processing[w].status == 'convert')
		{
			processing[w].status = 'working';
			log(`moving ${processing[w].name} from 'convert' to 'working'`);
		}
	}

	do
	{
		cullCheck = false;
		for (let d = 0; d < processing.length; d++)
		{
			if (processing[d].status == 'cull')
			{
				processing.splice(d, 1);
				log(`cullCheck(processing) index=${d} culled (${processing.length} items)`);
				cullCheck = true;
				break;
			}
		}
	} while (cullCheck);

	/* check the procesing queue to see how the files are going */
	setTimeout(scheduledStuff, configuration.polling_interval_ms);
}

/* Better console.log */
function log(s)
{
	console.log(getDateTime() + ` ${s}`);
}

/**
 * date-time
 * @see https://usefulangle.com/post/187/nodejs-get-date-time
 */
function getDateTime()
{
	let date_ob = new Date();

	let date = ("0" + date_ob.getDate()).slice(-2);
	let month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
	let year = date_ob.getFullYear();
	let hours = date_ob.getHours();
	let minutes = date_ob.getMinutes();
	if (minutes < 10) { minutes = "0" + minutes; }
	let seconds = date_ob.getSeconds();
	if (seconds < 10) { seconds = "0" + seconds; }
	// prints date & time in YYYY-MM-DD HH:MM:SS format
	let dateTime = year + "-" + month + "-" + date + " " + hours + ":" + minutes + ":" + seconds;
	return dateTime;
}

function reConfigure()
{
	/* Open our video-converter.json file. Announce if anything changes w/ configuration. */
	let file_config_json = null;
	let file_config = {};
	try
	{
		file_config_json = fs.readFileSync('video-converter.json');
		file_config = JSON.parse(file_config_json);
	}
	catch (e)
	{
		log('reConfigure(): catch()=' + e);
		return;
	}

	let keys = Object.keys(configuration);
	for (let k = 0; k < keys.length; k++)
	{
		if (configuration.hasOwnProperty(keys[k]))
		{
			if (configuration[keys[k]] != file_config[keys[k]])
			{
				// change configuration and log it
				log(`config change, key=${keys[k]}, old=${configuration[keys[k]]}, new=${file_config[keys[k]]}`);
				configuration[keys[k]] = file_config[keys[k]];
			}
		}
		//console.log(`config[${keys[k]}] = ${configuration[keys[k]]}`);
	}
}

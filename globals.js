const STATE = {	
	ready: 'ready',
	in_progress: 'in-progress',
	completed: 'completed',
	paused: 'paused',
	canceled: 'canceled',
	interrupted: 'error'
};
const DOWNLOAD_STATUS = {
	unknown: 0,
	started: 1,
	completed: 2,
	refresh: 3
};
const PROGRES_ACTIONS = {
	pause: 'pause',
	resume: 'resume',
	cancel: 'cancel',
	show: 'show'
}
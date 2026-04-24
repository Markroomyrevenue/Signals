with timeout of 180 seconds
	set appPath to POSIX path of (path to me)
	set repoRoot to do shell script "/usr/bin/dirname " & quoted form of appPath
	set scriptPath to repoRoot & "/scripts/start-signals-background.sh"

	try
		display notification "Starting Signals..." with title "Signals"
		do shell script quoted form of scriptPath
		display notification "Signals is ready." with title "Signals"
	on error errMsg number errNum
		display dialog "Signals could not start." & return & return & errMsg buttons {"OK"} default button "OK" with icon stop
		error number errNum
	end try
end timeout

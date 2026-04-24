with timeout of 60 seconds
	set appPath to POSIX path of (path to me)
	set repoRoot to do shell script "/usr/bin/dirname " & quoted form of appPath
	set scriptPath to repoRoot & "/scripts/stop-signals-background.sh"

	try
		do shell script quoted form of scriptPath
		display notification "Signals has been stopped." with title "Signals"
	on error errMsg number errNum
		display dialog "Signals could not stop cleanly." & return & return & errMsg buttons {"OK"} default button "OK" with icon stop
		error number errNum
	end try
end timeout

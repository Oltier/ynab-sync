cd ./lambdas || exit

GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o bootstrap cmd/ynabber/main.go

cd ..

cdk deploy
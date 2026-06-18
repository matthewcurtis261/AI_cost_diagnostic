package main

import (
	"context"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

func invoke(ctx context.Context, client *bedrockruntime.Client) error {
	modelID := "anthropic.claude-3-sonnet-20240229-v1:0"
	_, err := client.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{
		ModelId: &modelID,
	})
	return err
}
